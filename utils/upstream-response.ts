/**
 * Upstream reads that look like JSON but are not.
 *
 * get.data.gov.lt answers a blocked or overloaded request with HTML — a FortiWeb
 * "Firewall Captcha Authentication" page (HTTP 200) or a plain error page — and
 * the JSON parse that follows throws a generic client error. That error is all
 * that reached the logs, so a month of failed runs said only "Moleculer HTTP
 * Client Error." with no status, no URL and no upstream message.
 */

export class UpstreamResponseError extends Error {
  constructor(message: string, readonly url: string, readonly status?: number) {
    super(message);
    this.name = 'UpstreamResponseError';
  }
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Names what actually came back, so the failure is legible without a debugger.
 * Returns the payload untouched when it is a normal response.
 */
export function assertJsonPayload(payload: unknown, url: string): any {
  if (typeof payload === 'string') {
    const text = payload.trimStart();
    if (/^</.test(text)) {
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
      const captcha = /Firewall Captcha|Security check/i.test(text);
      throw new UpstreamResponseError(
        captcha
          ? `upstream answered with a firewall CAPTCHA page${title ? ` ("${title}")` : ''}`
          : `upstream answered with HTML instead of JSON${title ? ` ("${title}")` : ''}`,
        url,
      );
    }
    throw new UpstreamResponseError(`upstream answered with text: ${firstLine(text)}`, url);
  }

  // Spinta reports its own failures as JSON, e.g.
  // {"errors":[{"code":"OSError","message":"[Errno 24] Too many open files: …"}]}
  const errors = (payload as any)?.errors;
  if (Array.isArray(errors) && errors.length) {
    const first: { code?: string; message?: string } = errors[0] ?? {};
    const { code, message } = first;
    throw new UpstreamResponseError(
      `upstream error${code ? ` ${code}` : ''}: ${message ?? JSON.stringify(errors[0])}`,
      url,
    );
  }

  return payload;
}
