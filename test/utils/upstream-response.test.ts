import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertJsonPayload, UpstreamResponseError } from '../../utils/upstream-response';

const URL = 'https://get.data.gov.lt/datasets/gov/ssva/infostatyba/Statinys/:format/json?count()';

const failsWith = (payload: unknown, expected: RegExp) => {
  assert.throws(
    () => assertJsonPayload(payload, URL),
    (err: unknown) => {
      if (!(err instanceof UpstreamResponseError)) {
        throw new Error(`tikėtasi UpstreamResponseError, gauta ${String(err)}`);
      }
      assert.match(err.message, expected);
      assert.equal(err.url, URL);
      return true;
    },
  );
};

describe('assertJsonPayload', () => {
  it('passes a normal response through untouched', () => {
    const payload = { _data: [{ _id: 'a', statinio_id: '1' }] };
    assert.equal(assertJsonPayload(payload, URL), payload);
  });

  it('passes a response with an empty page through', () => {
    const payload = { _data: [] as unknown[] };
    assert.equal(assertJsonPayload(payload, URL), payload);
  });

  // The failure that reported nothing but "Moleculer HTTP Client Error." for a month.
  it('names a firewall CAPTCHA page', () => {
    const html =
      '<!DOCTYPE HTML><html><head><title>Firewall Captcha Authentication</title></head>' +
      '<body><h2>Security check</h2></body></html>';
    failsWith(html, /firewall CAPTCHA page \("Firewall Captcha Authentication"\)/);
  });

  it('names plain HTML that is not a CAPTCHA', () => {
    failsWith(
      '<html><head><title>502 Bad Gateway</title></head><body></body></html>',
      /HTML instead of JSON \("502 Bad Gateway"\)/,
    );
  });

  it('names HTML with no title', () => {
    failsWith('  <html><body>nope</body></html>', /HTML instead of JSON$/);
  });

  // Spinta reports its own failures as JSON with HTTP 500.
  it('names an upstream error payload', () => {
    failsWith(
      {
        errors: [
          {
            code: 'OSError',
            message: "[Errno 24] Too many open files: '/opt/spinta/config/keys/private.json'",
          },
        ],
      },
      /upstream error OSError: \[Errno 24\] Too many open files/,
    );
  });

  it('names an error payload with no code', () => {
    failsWith({ errors: [{ message: 'boom' }] }, /upstream error: boom/);
  });

  it('names an unexpected text body', () => {
    failsWith('Service Unavailable', /answered with text: Service Unavailable/);
  });

  it('truncates a long text body', () => {
    let message = '';
    try {
      assertJsonPayload('x'.repeat(500), URL);
    } catch (err) {
      message = (err as Error).message;
    }
    assert.ok(
      message.length > 0 && message.length < 260,
      `per ilgas pranešimas: ${message.length}`,
    );
  });

  it('leaves an empty errors array alone', () => {
    const payload = { _data: [] as unknown[], errors: [] as unknown[] };
    assert.equal(assertJsonPayload(payload, URL), payload);
  });
});
