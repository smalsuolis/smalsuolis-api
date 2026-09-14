import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPortalRecords, findParserGaps } from '../../utils/savivaldybeZemetvarka/sources';

const INDEX = `<div class="field field--name-body field--item">
  <a href="/planuoju_rtpd/testo_raj">Testo raj.</a>
</div>`;

const SECTION = `<div class="field field--name-body field--item">
  <a href="/planuoju_rtpd/testo_raj/pagal_20_2_2">Prašymai</a>
  <a href="/planuoju_rtpd/testo_raj/detalieji">Detalieji</a>
</div>`;

const notice = (heading: string, body: string) =>
  `<p><strong>${heading}</strong></p><p>${body}</p>`;

const page = (notices: string) =>
  `<div class="field field--name-body field--item">${notices}</div>`;

/** Serves the three pages a portal read walks through. */
const fakePortal = (noticesHtml: string) => async (url: string) => {
  if (url.endsWith('savivaldybes_vietoves_lygmens_tpd')) return INDEX;
  if (url.endsWith('/testo_raj')) return SECTION;
  if (url.endsWith('/pagal_20_2_2')) return page(noticesHtml);
  throw new Error(`unexpected fetch: ${url}`);
};

describe('reading a municipality off the portal', () => {
  it('collects the notices and reports what it saw', async () => {
    const { records, stats } = await fetchPortalRecords(
      fakePortal(
        notice(
          '2026-08-17',
          'Informuojame, kad gautas prašymas dėl žemės sklypo (kadastro Nr. 3905/0009:4243) paskirties keitimo',
        ),
      ),
      { today: '2026-08-27' },
    );

    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'portal');
    assert.equal(records[0].municipalitySlug, 'testo_raj');
    assert.equal(records[0].municipalityName, 'Testo raj.');
    assert.equal(records[0].publishedAt, '2026-08-17');
    assert.deepEqual(records[0].parcels.cadastrals, ['3905/0009:4243']);
    assert.ok(records[0].externalId.startsWith('portal:testo_raj:'));

    assert.equal(stats.length, 1);
    assert.equal(stats[0].records, 1);
    assert.equal(stats[0].pages, 1);
  });

  it('reads only the land-use pages, not the rest of the section', async () => {
    const { stats } = await fetchPortalRecords(
      fakePortal(notice('2026-08-17', 'kadastro Nr. 3905/0009:4243')),
      { today: '2026-08-27' },
    );
    assert.equal(stats[0].pages, 1);
  });

  it('records a municipality that fails instead of losing the whole run', async () => {
    const failing = async (url: string) => {
      if (url.endsWith('savivaldybes_vietoves_lygmens_tpd')) return INDEX;
      throw new Error('HTTP 503');
    };
    const { records, stats } = await fetchPortalRecords(failing, { today: '2026-08-27' });
    assert.equal(records.length, 0);
    assert.equal(stats[0].error, 'HTTP 503');
  });

  it('honours the skip list', async () => {
    const { stats } = await fetchPortalRecords(
      fakePortal(notice('2026-08-17', 'kadastro Nr. 3905/0009:4243')),
      {
        skipSlugs: ['testo_raj'],
        today: '2026-08-27',
      },
    );
    assert.equal(stats.length, 0);
  });
});

describe('spotting a parser that has fallen behind the page', () => {
  it('flags a page publishing dates no record was built from', async () => {
    // A notice with no parcel number yields no record, so the page moves on and
    // the parser does not. This is the failure that otherwise looks like a
    // municipality going quiet.
    const html =
      notice('2026-03-23', 'kadastro Nr. 3905/0009:4243') +
      notice('2026-07-28', 'Informuojame apie sklypą Klevų g. 7 — be numerio');

    const { stats } = await fetchPortalRecords(fakePortal(html), { today: '2026-08-27' });
    const gaps = findParserGaps(stats);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].newestDateOnPage, '2026-07-28');
    assert.equal(gaps[0].newestRecordDate, '2026-03-23');
  });

  it('does not mistake a future comment deadline for a page running ahead', async () => {
    // Every healthy notice states a deadline weeks out, and a deadline is always
    // later than the publication it belongs to. Counting future dates reported
    // 36 of 59 municipalities as behind when almost none were.
    const html = notice(
      '2026-08-17',
      'gautas prašymas (kadastro Nr. 3905/0009:4243); pasiūlymus teikti iki 2026-11-20',
    );

    const { stats } = await fetchPortalRecords(fakePortal(html), { today: '2026-08-27' });
    assert.deepEqual(findParserGaps(stats), []);
  });
});
