import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  subscribePassword: required('TELEGRAM_SUBSCRIBE_PASSWORD'),
  apiBaseUrl: required('WATCHDOG_API_URL'),
  dbPath: process.env.WATCHDOG_DB_PATH ?? './data/watchdog.db',
  livenessIntervalMs: Number(process.env.WATCHDOG_LIVENESS_INTERVAL_MS ?? 150_000),
  livenessFailuresBeforeAlert: Number(process.env.WATCHDOG_LIVENESS_FAILURES ?? 2),
  livenessRequestTimeoutMs: Number(process.env.WATCHDOG_LIVENESS_TIMEOUT_MS ?? 10_000),
  stalenessRequestTimeoutMs: Number(
    process.env.WATCHDOG_STALENESS_REQUEST_TIMEOUT_MS ?? 3 * 60 * 1000,
  ),
  stalenessIntervalMs: Number(process.env.WATCHDOG_STALENESS_INTERVAL_MS ?? 60 * 60 * 1000),
  // Default staleness threshold for daily-updating integrations (infostatyba,
  // izuvinimas, zemetvarkosPlanavimas). These reliably receive new data every
  // 1–5 days, so 8d flags a real break with a little margin.
  stalenessThresholdMs: Number(
    process.env.WATCHDOG_STALENESS_THRESHOLD_MS ?? 8 * 24 * 60 * 60 * 1000,
  ),
  // Per-integration overrides for sources that legitimately publish in bursts,
  // so their normal quiet spells don't page anyone. Threshold picked from the
  // source's observed max healthy gap (see PR): miskoKirtimai tops out ~7d → 12d.
  // Freshness is measured off real data (newest event / last insert), not the
  // cron-warmed lastUpdate — see freshnessAgeMs in checks.ts.
  //
  // savivaldybesZemetvarka had a 21d override while it covered Vilnius alone and
  // could sit quiet for ~13d. Collecting all 60 municipalities it receives
  // notices almost daily, so the 8d default is now the right alarm and a 21d one
  // would hide a real break. Removing the entry rather than renaming its key also
  // means a watchdog image built before the rename degrades to that same default
  // instead of matching nothing.
  stalenessThresholdByAppKeyMs: {
    miskoKirtimai: 12 * 24 * 60 * 60 * 1000,
  } as Record<string, number>,
  alertCooldownMs: Number(process.env.WATCHDOG_ALERT_COOLDOWN_MS ?? 6 * 60 * 60 * 1000),
  livenessRepeatIntervalMs: Number(process.env.WATCHDOG_LIVENESS_REPEAT_MS ?? 30 * 60 * 1000),
  displayTimezone: process.env.WATCHDOG_TIMEZONE ?? 'Europe/Vilnius',
  // Skip the first N ms after watchdog startup before beginning health polls.
  // Prevents false "API unreachable" alerts when the watchdog container comes
  // up a few seconds before the API container finishes initializing during
  // a deploy. Default 90s — long enough for most deploys, short enough that a
  // genuinely dead API still gets detected within the liveness threshold.
  startupGraceMs: Number(process.env.WATCHDOG_STARTUP_GRACE_MS ?? 90_000),
};
