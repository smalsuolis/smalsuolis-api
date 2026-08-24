import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Decodo residential proxy — the only way to reach the LT-only upstreams
 * (vilnius.lt, lkmp.alisas.lt) from the foreign VPS the API runs on.
 *
 * Unlike the mTLS jump proxy this replaces, targeting lives in the proxy
 * USERNAME, not in the URL — upstream URLs stay untouched:
 *   user-<sub>-country-lt[-session-<id>-sessionduration-<minutes>]
 *
 * DECODO_PROXY_URL example (percent-encode the password if it holds @ : /):
 *   http://user-<sub>-country-lt:<password>@gate.decodo.com:7000
 *
 * Absent in local dev (LT IP) — requests then go straight to the upstream.
 */

// Decodo caps sticky sessions at 30 min; a scrape run stays well under that.
const SESSION_DURATION_MINUTES = 10;

const agents = new Map<string, HttpsProxyAgent<string>>();

function getAgent(proxyUrl: string, session?: string) {
  const cached = agents.get(session || '');
  if (cached) return cached;

  const url = new URL(proxyUrl);
  if (session) {
    url.username = `${url.username}-session-${session}-sessionduration-${SESSION_DURATION_MINUTES}`;
  }

  const agent = new HttpsProxyAgent<string>(url.href);
  agents.set(session || '', agent);
  return agent;
}

/**
 * @param session sticky-session id — keeps one exit IP for a whole scrape run
 * instead of a fresh IP per request. Omit for one-shot downloads.
 */
export function buildLtProxyOpt(session?: string) {
  const proxyUrl = process.env.DECODO_PROXY_URL;

  if (!proxyUrl) {
    // Every deployed environment (development included) runs on a foreign host,
    // so going direct there means a 403 that reads like the upstream broke
    // rather than like missing config. Fail where it is diagnosable. Only a
    // developer machine — NODE_ENV=local, or unset — is assumed to sit on a
    // Lithuanian IP and may talk to the upstream directly.
    const deployed = !!process.env.NODE_ENV && process.env.NODE_ENV !== 'local';
    if (deployed) {
      throw new Error(
        `DECODO_PROXY_URL is not set — refusing to fetch an LT-only upstream directly (NODE_ENV=${process.env.NODE_ENV})`,
      );
    }
    return {};
  }

  return { agent: { https: getAgent(proxyUrl, session) } };
}
