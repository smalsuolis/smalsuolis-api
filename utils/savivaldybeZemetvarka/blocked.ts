/**
 * Requests these sites refuse while answering HTTP 200.
 *
 * Several municipality sites sit behind an F5 web firewall that returns a
 * refusal page with a 200 status. Nothing about the response says it failed:
 * the status is fine, the body is HTML, and a parser looking for notices simply
 * finds none — so a block reads as "this municipality has published nothing",
 * which is the one conclusion that must never be reached by accident.
 *
 * arsa.lt does this after roughly two dozen requests in a row, so it is a rate
 * limit rather than a ban, and 42 of its 66 notices went missing behind it.
 */

// The Lithuanian wording is what actually appears — "nurodydami bylos numerį",
// declined, so matching the nominative "bylos numeris" misses it. Matching the
// stem covers every case ending. The English strings cover the same firewall's
// other localisation and the CAPTCHA variant seen on get.data.gov.lt.
const BLOCK_MARKERS = [
  /bylos\s+numer/i,
  /įvyko\s+klaida\.\./i,
  /unauthorized\s+request\s+blocked/i,
  /firewall\s+captcha/i,
  /security\s+check/i,
  /request\s+rejected/i,
];

export class UpstreamBlockedError extends Error {
  constructor(readonly url: string) {
    super(`upstream answered 200 with a firewall page instead of content (${url})`);
    this.name = 'UpstreamBlockedError';
  }
}

/** True when a 200 response is really a refusal. */
export function looksBlocked(html: string): boolean {
  return BLOCK_MARKERS.some((re) => re.test(html));
}

/** Returns the body untouched, or throws naming what actually came back. */
export function assertNotBlocked(html: string, url: string): string {
  if (looksBlocked(html)) throw new UpstreamBlockedError(url);
  return html;
}
