// Thin wrapper around console that prepends an ISO UTC timestamp to every
// line. Kept separate from the EEST timestamps used in Telegram alerts —
// logs are for operators debugging from container stdout / docker logs and
// should stay in a standard, unambiguous format.

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...args: unknown[]) => console.log(`[${ts()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}]`, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}]`, ...args),
};
