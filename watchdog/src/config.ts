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
  stalenessIntervalMs: Number(process.env.WATCHDOG_STALENESS_INTERVAL_MS ?? 60 * 60 * 1000),
  stalenessThresholdMs: Number(
    process.env.WATCHDOG_STALENESS_THRESHOLD_MS ?? 7 * 24 * 60 * 60 * 1000,
  ),
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
