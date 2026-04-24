import { Telegraf } from 'telegraf';
import { config } from './config';
import { broadcast } from './alerts';
import {
  clearAlert,
  deleteKv,
  getAlertLastSent,
  getKv,
  getServiceState,
  markAlertSent,
  setKv,
  setServiceState,
} from './db';
import { log } from './logger';

interface ServiceStatus {
  ok: boolean;
  error?: string;
}

interface HealthResponse {
  ok: boolean;
  timestamp: number;
  services: {
    postgres: ServiceStatus;
    redis: ServiceStatus;
    auth: ServiceStatus;
  };
}

interface AppLastUpdate {
  app: string;
  appId: number;
  appKey: string;
  appType: string;
  lastUpdate: string | null;
  eventCount: number;
  lastUpdateCount: number;
  lastRunAt: string | null;
  lastRunError: string | null;
}

interface LastUpdateResponse {
  lastGlobalUpdate: string | null;
  firstGlobalEvent: string | null;
  apps: AppLastUpdate[];
}

interface ServiceRow {
  key: string;
  label: string;
  ok: boolean;
}

type Annotation = 'steady_up' | 'just_down' | 'still_down' | 'recovered';

interface ServiceAnnotation extends ServiceRow {
  annotation: Annotation;
  downSince: Date | null;
  durationMs: number;
}

const API_KEY = 'api';

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function formatTimestamp(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.displayTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get(
    'second',
  )} ${get('timeZoneName')}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function simpleBreakdown(services: ServiceRow[]): string {
  return services.map((s) => `• ${s.label}: ${s.ok ? '✅' : '❌'}`).join('\n');
}

function annotatedBreakdown(annotations: ServiceAnnotation[]): string {
  return annotations
    .map((a) => {
      const mark = a.ok ? '✅' : '❌';
      let suffix = '';
      if (a.annotation === 'just_down') suffix = ' (just went down)';
      else if (a.annotation === 'still_down' && a.downSince)
        suffix = ` (down ${formatDuration(a.durationMs)})`;
      else if (a.annotation === 'recovered')
        suffix = ` (recovered after ${formatDuration(a.durationMs)})`;
      return `• ${a.label}: ${mark}${suffix}`;
    })
    .join('\n');
}

function servicesFromHealth(health: HealthResponse): ServiceRow[] {
  return [
    { key: 'postgres', label: 'postgres', ok: health.services.postgres.ok },
    { key: 'redis', label: 'redis', ok: health.services.redis.ok },
    { key: 'auth', label: 'auth api', ok: health.services.auth.ok },
  ];
}

async function handleApiDown(bot: Telegraf, fetchError: string | null, now: Date): Promise<void> {
  const state = getServiceState(API_KEY);
  const nextFailures = state.consecutiveFailures + 1;
  const reached = nextFailures >= config.livenessFailuresBeforeAlert;
  let downSince = state.downSince;
  let lastAlertAt = state.lastAlertAt;

  if (reached) {
    if (!downSince) {
      const candidateSince = now;
      const delivered = await broadcast(
        bot,
        [
          `🚨 *API unreachable*`,
          `_${formatTimestamp(now)}_`,
          '',
          `Down since ${formatTimestamp(candidateSince)}`,
        ].join('\n'),
      );
      if (delivered) {
        downSince = candidateSince;
        lastAlertAt = now;
      }
    } else if (
      !lastAlertAt ||
      now.getTime() - lastAlertAt.getTime() >= config.livenessRepeatIntervalMs
    ) {
      const duration = now.getTime() - downSince.getTime();
      const delivered = await broadcast(
        bot,
        [
          `⏳ *API still unreachable* (${formatDuration(duration)})`,
          `_${formatTimestamp(now)}_`,
          '',
          `Down since ${formatTimestamp(downSince)}`,
        ].join('\n'),
      );
      if (delivered) lastAlertAt = now;
    }
  }

  setServiceState({
    name: API_KEY,
    consecutiveFailures: nextFailures,
    downSince,
    lastAlertAt,
    lastError: fetchError,
  });
}

async function handleApiRecoveryIfNeeded(
  bot: Telegraf,
  health: HealthResponse,
  now: Date,
): Promise<void> {
  const state = getServiceState(API_KEY);
  if (state.downSince && state.lastAlertAt) {
    // Only announce recovery if we previously told anyone about the outage.
    // If lastAlertAt is null, the down alert was never delivered (no subs),
    // so there's nothing to "recover" from their perspective.
    const duration = now.getTime() - state.downSince.getTime();
    await broadcast(
      bot,
      [
        `✅ *API back up*`,
        `_${formatTimestamp(now)}_`,
        `Was down ${formatDuration(duration)} (since ${formatTimestamp(state.downSince)})`,
        '',
        simpleBreakdown(servicesFromHealth(health)),
      ].join('\n'),
    );
  }
  setServiceState({
    name: API_KEY,
    consecutiveFailures: 0,
    downSince: null,
    lastAlertAt: null,
    lastError: null,
  });
}

async function handleServiceEvaluations(
  bot: Telegraf,
  health: HealthResponse,
  now: Date,
): Promise<void> {
  const services = servicesFromHealth(health);
  const annotations: ServiceAnnotation[] = [];

  // Per-service: `base` is persisted unconditionally; `lastAlertAtIfDelivered`
  // only overwrites `base.lastAlertAt` when the broadcast reaches ≥1 subscriber.
  // This prevents an undelivered alert (e.g. when no one's subscribed yet)
  // from looking like a delivered one and locking out future retries.
  interface Plan {
    base: {
      name: string;
      consecutiveFailures: number;
      downSince: Date | null;
      lastAlertAt: Date | null;
    };
    lastAlertAtIfDelivered?: Date | null;
    clearAlertKeyIfDelivered?: string;
  }
  const plans: Plan[] = [];

  let hasNewDown = false;
  let hasRecovery = false;
  let hasRepeat = false;

  for (const svc of services) {
    const state = getServiceState(svc.key);
    let annotation: Annotation = 'steady_up';
    let nextFailures = state.consecutiveFailures;
    let downSince = state.downSince;
    let lastAlertAt = state.lastAlertAt;
    let durationMs = 0;
    let lastAlertAtIfDelivered: Plan['lastAlertAtIfDelivered'];
    let clearAlertKeyIfDelivered: string | undefined;

    if (!svc.ok) {
      nextFailures = state.consecutiveFailures + 1;
      const reached = nextFailures >= config.livenessFailuresBeforeAlert;
      if (!reached) {
        annotation = downSince ? 'still_down' : 'steady_up';
      } else if (!state.lastAlertAt) {
        // First alert hasn't been delivered yet (either threshold just reached
        // or previous attempts had no subscribers). Track downSince from the
        // first observation; try to fire the first-down alert.
        if (!downSince) downSince = now;
        annotation = 'just_down';
        hasNewDown = true;
        lastAlertAtIfDelivered = now;
      } else if (now.getTime() - state.lastAlertAt.getTime() >= config.livenessRepeatIntervalMs) {
        annotation = 'still_down';
        hasRepeat = true;
        lastAlertAtIfDelivered = now;
      } else {
        annotation = 'still_down';
      }
      if (downSince) durationMs = now.getTime() - downSince.getTime();
    } else if (state.downSince && state.lastAlertAt) {
      // Was down and we told someone — announce recovery, reset all state.
      annotation = 'recovered';
      durationMs = now.getTime() - state.downSince.getTime();
      hasRecovery = true;
      downSince = null;
      lastAlertAt = null;
      nextFailures = 0;
      clearAlertKeyIfDelivered = `service:${svc.key}`;
    } else {
      // Either never went down, or went down but never alerted. Reset silently.
      nextFailures = 0;
      downSince = null;
      lastAlertAt = null;
    }

    annotations.push({
      ...svc,
      annotation,
      downSince: annotation === 'recovered' ? null : downSince,
      durationMs,
    });

    plans.push({
      base: {
        name: svc.key,
        consecutiveFailures: nextFailures,
        downSince,
        lastAlertAt,
      },
      lastAlertAtIfDelivered,
      clearAlertKeyIfDelivered,
    });
  }

  const needsBroadcast = hasNewDown || hasRecovery || hasRepeat;
  let delivered = false;

  if (needsBroadcast) {
    const header = hasNewDown
      ? '🚨 *Service update*'
      : hasRepeat
      ? '⏳ *Service update — still down*'
      : '✅ *Service update*';
    delivered = await broadcast(
      bot,
      [header, `_${formatTimestamp(now)}_`, '', annotatedBreakdown(annotations)].join('\n'),
    );
  }

  for (const plan of plans) {
    setServiceState({
      ...plan.base,
      lastAlertAt:
        delivered && plan.lastAlertAtIfDelivered !== undefined
          ? plan.lastAlertAtIfDelivered
          : plan.base.lastAlertAt,
      lastError: null,
    });
    if (delivered && plan.clearAlertKeyIfDelivered) {
      clearAlert(plan.clearAlertKeyIfDelivered);
    }
  }
}

export async function runLivenessCheck(bot: Telegraf): Promise<void> {
  const url = `${config.apiBaseUrl}/health`;
  const now = new Date();

  let health: HealthResponse | null = null;
  let fetchError: string | null = null;
  try {
    health = await fetchJson<HealthResponse>(url, config.livenessRequestTimeoutMs);
  } catch (err: any) {
    fetchError = err?.message ?? 'unknown error';
  }

  if (!health) {
    await handleApiDown(bot, fetchError, now);
    log.info(`[watchdog] liveness api=unreachable (${fetchError ?? 'no error'})`);
    return;
  }

  await handleApiRecoveryIfNeeded(bot, health, now);
  await handleServiceEvaluations(bot, health, now);

  const summary = servicesFromHealth(health)
    .map((s) => `${s.key}=${s.ok ? 'ok' : 'down'}`)
    .join(' ');
  log.info(`[watchdog] liveness api=ok ${summary}`);
}

export async function runStalenessCheck(bot: Telegraf): Promise<void> {
  // Bypass the endpoint's 6h cache — watchdog needs fresh data to detect
  // staleness in a timely manner. The cache still benefits user-facing callers.
  const url = `${config.apiBaseUrl}/integrations/last-update?noCache=true`;

  let data: LastUpdateResponse;
  try {
    data = await fetchJson<LastUpdateResponse>(url, config.livenessRequestTimeoutMs);
  } catch (err: any) {
    log.error('[watchdog] staleness fetch failed:', err?.message ?? err);
    return;
  }

  const now = new Date();
  await checkIntegrationFailures(bot, data, now);
  await checkStaleness(bot, data, now);
}

async function checkIntegrationFailures(
  bot: Telegraf,
  data: LastUpdateResponse,
  now: Date,
): Promise<void> {
  // Bookkeeping can go stale: if apps.update times out inside
  // recordRunFailure/Success (same Moleculer layer that's flaking), the apps
  // row keeps yesterday's error even though today's cron ran. Detect that by
  // comparing when events were last touched to when the outcome was last
  // recorded — if events are fresher, the cron ran again and did work, so
  // treat the old error as resolved.
  const failing = (data.apps ?? []).filter((a) => {
    if (!a.lastRunError) return false;
    if (a.lastUpdate && a.lastRunAt && new Date(a.lastUpdate) > new Date(a.lastRunAt)) {
      return false;
    }
    return true;
  });

  if (failing.length === 0) {
    const hadPrev = !!getKv('integration_failures:set');
    if (!hadPrev) return;
    const delivered = await broadcast(
      bot,
      [`✅ *All integrations running again*`, `_${formatTimestamp(now)}_`].join('\n'),
    );
    if (delivered) {
      clearAlert('integration_failures');
      deleteKv('integration_failures:set');
    }
    return;
  }

  // Dedup on (appKey, errorMessage) — if the error text changes on any app,
  // treat as a new signal and re-alert. Pure-time cooldown alone would hide
  // follow-up / different errors on the same app.
  const currentHash = failing
    .map((a) => `${a.appKey}::${a.lastRunError}`)
    .sort()
    .join('|');
  const previousHash = getKv('integration_failures:set');
  const lastSent = getAlertLastSent('integration_failures');
  const cooldownPassed = !lastSent || Date.now() - lastSent.getTime() >= config.alertCooldownMs;

  if (currentHash === previousHash && !cooldownPassed) return;

  const lines = failing.map((a) => {
    const when = a.lastRunAt ? formatTimestamp(new Date(a.lastRunAt)) : 'unknown time';
    return [`🚨 *${a.app}* _(${a.appKey})_`, `failed at ${when}`, `\`${a.lastRunError}\``].join(
      '\n',
    );
  });

  const msg = [
    `🚨 *Integration failures (${failing.length})*`,
    `_${formatTimestamp(now)}_`,
    '',
    ...lines.flatMap((l) => [l, '']),
  ]
    .join('\n')
    .trimEnd();

  const delivered = await broadcast(bot, msg);
  if (delivered) {
    markAlertSent('integration_failures');
    setKv('integration_failures:set', currentHash);
  }
}

async function checkStaleness(bot: Telegraf, data: LastUpdateResponse, now: Date): Promise<void> {
  const threshold = config.stalenessThresholdMs;

  // Skip apps that have never received data — that's a fresh-DB / setup state,
  // not a breakage, so it shouldn't page anyone. Only alert when data EXISTED
  // and has since gone stale.
  const stale = (data.apps ?? [])
    .filter((app) => app.lastUpdate)
    .map((app) => ({
      app,
      ageMs: now.getTime() - new Date(app.lastUpdate!).getTime(),
    }))
    .filter(({ ageMs }) => ageMs > threshold)
    .sort((a, b) => b.ageMs - a.ageMs);

  if (stale.length === 0) {
    const hadPreviouslyStale = !!getKv('staleness:set');
    if (!hadPreviouslyStale) return; // nothing was stale, nothing to announce

    const delivered = await broadcast(
      bot,
      [
        `✅ *All integrations fresh again*`,
        `_${formatTimestamp(now)}_`,
        `_stale threshold: ${formatDuration(threshold)}_`,
      ].join('\n'),
    );
    if (delivered) {
      clearAlert('staleness');
      deleteKv('staleness:set');
    }
    return;
  }

  // Diff-based dedup: if the set of stale appKeys is the same as last alert,
  // respect cooldown. If the set changed (new stale, or one recovered),
  // send immediately so the user sees the delta.
  const currentHash = stale
    .map((s) => s.app.appKey)
    .sort()
    .join(',');
  const previousHash = getKv('staleness:set');
  const lastSent = getAlertLastSent('staleness');
  const cooldownPassed = !lastSent || Date.now() - lastSent.getTime() >= config.alertCooldownMs;

  if (currentHash === previousHash && !cooldownPassed) return;

  const lines = stale.map(({ app, ageMs }) => {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const ageLabel = days >= 1 ? `${days}d ago` : `${formatDuration(ageMs)} ago`;
    return `⚠️ ${app.app} — ${ageLabel} _(${app.appKey})_`;
  });

  const msg = [
    `⚠️ *Stale integrations (${stale.length})*`,
    `_${formatTimestamp(now)}_`,
    `_stale threshold: ${formatDuration(threshold)}_`,
    '',
    ...lines,
  ].join('\n');

  const delivered = await broadcast(bot, msg);
  if (delivered) {
    markAlertSent('staleness');
    setKv('staleness:set', currentHash);
  }
}

export function startLoops(bot: Telegraf): void {
  const livenessTick = async () => {
    try {
      await runLivenessCheck(bot);
    } catch (err: any) {
      log.error('[watchdog] liveness loop error:', err?.message ?? err);
    }
  };
  const stalenessTick = async () => {
    try {
      await runStalenessCheck(bot);
    } catch (err: any) {
      log.error('[watchdog] staleness loop error:', err?.message ?? err);
    }
  };

  // Delay the first liveness poll by the startup grace window so the
  // watchdog doesn't alert during its own / the API's cold-start when
  // deploys roll both simultaneously.
  log.info(
    `delaying first liveness poll by ${Math.round(
      config.startupGraceMs / 1000,
    )}s to absorb deploy warmup`,
  );
  setTimeout(() => {
    livenessTick();
    setInterval(livenessTick, config.livenessIntervalMs);
  }, config.startupGraceMs);

  // Staleness runs less often and can't false-trigger on a cold API, so
  // let it start right away.
  stalenessTick();
  setInterval(stalenessTick, config.stalenessIntervalMs);
}

// --- table helpers --------------------------------------------------------

function formatAgeShort(ageMs: number): string {
  if (ageMs < 60_000) return 'now';
  const m = Math.floor(ageMs / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function padCell(value: string, width: number, align: 'l' | 'r' = 'l'): string {
  if (value.length > width) return value.slice(0, Math.max(0, width - 1)) + '…';
  return align === 'r' ? value.padStart(width) : value.padEnd(width);
}

// Wrap lines in a Markdown triple-backtick block so Telegram renders them in
// a monospace font. Without the fixed-width font column alignment breaks.
function codeBlock(body: string): string {
  return '```\n' + body + '\n```';
}

// --- commands -------------------------------------------------------------

export async function manualIntegrationsStatus(): Promise<string> {
  const now = new Date();
  let data: LastUpdateResponse;
  try {
    data = await fetchJson<LastUpdateResponse>(
      `${config.apiBaseUrl}/integrations/last-update?noCache=true`,
      config.livenessRequestTimeoutMs,
    );
  } catch (err: any) {
    return [
      `🚨 *Failed to fetch integration status*`,
      `_as of ${formatTimestamp(now)}_`,
      '',
      `_${err?.message ?? 'unknown error'}_`,
    ].join('\n');
  }

  const threshold = config.stalenessThresholdMs;
  const apps = [...(data.apps ?? [])].sort((a, b) => {
    const aAge = a.lastUpdate ? now.getTime() - new Date(a.lastUpdate).getTime() : Infinity;
    const bAge = b.lastUpdate ? now.getTime() - new Date(b.lastUpdate).getTime() : Infinity;
    return bAge - aAge;
  });

  // Fixed column widths picked to fit Lithuanian labels on a mobile-sized
  // Telegram monospace line without wrapping. Status glyphs live at the end
  // of each row — dropping them into a leading column throws off the
  // following column alignment because warning/emoji glyphs don't render as
  // exactly one monospace cell in Telegram.
  const WNAME = 22;
  const WAGE = 5;
  const WNEW = 5;

  const header =
    padCell('Integration', WNAME) +
    ' ' +
    padCell('Age', WAGE, 'r') +
    '  ' +
    padCell('+New', WNEW, 'r');
  const sep = '─'.repeat(header.length);

  const rows = apps.map((app) => {
    let trailing = '';
    let ageLabel: string;
    let countLabel: string;

    if (app.lastRunError) {
      trailing = '  🚨';
      ageLabel = 'ERR';
      countLabel = '—';
    } else if (!app.lastUpdate) {
      ageLabel = '—';
      countLabel = '0';
    } else {
      const ageMs = now.getTime() - new Date(app.lastUpdate).getTime();
      const isStale = ageMs > threshold;
      trailing = isStale ? '  ⚠️' : '';
      ageLabel = formatAgeShort(ageMs);
      countLabel = String(app.lastUpdateCount ?? 0);
    }

    return (
      padCell(app.app, WNAME) +
      ' ' +
      padCell(ageLabel, WAGE, 'r') +
      '  ' +
      padCell(countLabel, WNEW, 'r') +
      trailing
    );
  });

  // If any integration errored, show the full error message below the table
  // (the table itself only has room for a marker).
  const errors = apps
    .filter((a) => a.lastRunError)
    .map((a) => `🚨 *${a.app}* — \`${a.lastRunError}\``);

  return [
    `📊 *Integration freshness*`,
    `_${formatTimestamp(now)} — stale threshold: ${formatDuration(threshold)}_`,
    '',
    codeBlock([header, sep, ...rows].join('\n')),
    ...(errors.length ? ['', ...errors] : []),
  ].join('\n');
}

export async function manualStatus(): Promise<string> {
  const now = new Date();
  try {
    const health = await fetchJson<HealthResponse>(
      `${config.apiBaseUrl}/health`,
      config.livenessRequestTimeoutMs,
    );
    const header = health.ok ? '✅ *All systems healthy*' : '🚨 *Service(s) down*';

    const WNAME = 10;
    const rows = servicesFromHealth(health).map((s) => {
      const svcStatus = health.services[s.key as 'postgres' | 'redis' | 'auth'];
      const mark = s.ok ? 'UP  ' : 'DOWN';
      const err = svcStatus?.error ? `  ${svcStatus.error}` : '';
      return padCell(s.label, WNAME) + '  ' + mark + err;
    });
    const tableHeader = padCell('Service', WNAME) + '  ' + 'State';
    const sep = '─'.repeat(Math.max(tableHeader.length, ...rows.map((r) => r.length)));

    return [
      header,
      `_as of ${formatTimestamp(now)}_`,
      '',
      codeBlock([tableHeader, sep, ...rows].join('\n')),
    ].join('\n');
  } catch (err: any) {
    return [`🚨 *API unreachable*`, `_as of ${formatTimestamp(now)}_`].join('\n');
  }
}
