import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksBlocked } from '../../utils/savivaldybeZemetvarka/blocked';
import { fetchMunicipalSource, isLandUseNotice } from '../../utils/savivaldybeZemetvarka/municipal';
import { MUNICIPAL_SOURCES } from '../../utils/savivaldybeZemetvarka/municipalSources';

describe('spotting a refusal that arrives as HTTP 200', () => {
  it('recognises the Lithuanian firewall page', () => {
    // What arsa.lt actually returns once it starts refusing. Matching the
    // nominative "bylos numeris" misses it — the page declines the noun — and
    // 42 of that municipality's 66 notices went missing behind exactly this.
    const page =
      '<h1>Įvyko klaida..</h1><p>Jei manote, kad įvyko klaida ir puslapio turinys ' +
      'turėtų būti pasiekiamas, parašykite mums, nurodydami bylos numerį, šiuo el. paštu</p>';
    assert.equal(looksBlocked(page), true);
  });

  it('recognises the English variants', () => {
    assert.equal(looksBlocked('<title>Unauthorized Request Blocked</title>'), true);
    assert.equal(looksBlocked('<p>Firewall Captcha Authentication</p>'), true);
  });

  it('does not cry wolf over an ordinary notice page', () => {
    const page =
      '<h1>Informacija apie gautą prašymą pakeisti žemės sklypo (kadastro Nr. 3328/0002:212) ' +
      'pagrindinę žemės naudojimo paskirtį</h1>';
    assert.equal(looksBlocked(page), false);
  });
});

describe('telling a land-use notice from its neighbours', () => {
  it('accepts the wordings municipalities use', () => {
    assert.ok(
      isLandUseNotice(
        'Vadovaujantis LR teritorijų planavimo įstatymo 20 straipsnio 2 dalies 2 punktu',
      ),
    );
    assert.ok(isLandUseNotice('Gautas prašymas pakeisti pagrindinę žemės naudojimo paskirtį'));
    assert.ok(isLandUseNotice('dėl žemės naudojimo būdo pakeitimo'));
  });

  it('rejects the announcements that sit beside them', () => {
    // Rietavas files these in the same feed, and they carry parcel numbers too,
    // so a parcel number alone cannot decide what a document is.
    assert.equal(
      isLandUseNotice('Skelbiamas nenaudojamų, apleistų kitos paskirties žemės sklypų sąrašas'),
      false,
    );
  });
});

const page = (body: string) => `<div class="field--name-body">${body}</div>`;

describe('reading a municipality from its own site', () => {
  it('reads a cumulative page without demanding the legal wording in every row', () => {
    // Klaipėda's table states the subject in the page heading; its rows say only
    // "Žemės sklypas, kadastro Nr. …". Filtering on row text drops all of them.
    const source = MUNICIPAL_SOURCES.find((s) => s.slug === 'klaipedos_m')!;
    assert.notEqual(source.filterByContent, true);
  });

  it('collects rows from a cumulative page', async () => {
    const source = { ...MUNICIPAL_SOURCES.find((s) => s.slug === 'klaipedos_m')!, urls: ['x'] };
    const { records } = await fetchMunicipalSource(source, async () =>
      page('<p><strong>2026-04-23</strong></p><p>Žemės sklypas, kadastro Nr. 2101/0036:57</p>'),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].publishedAt, '2026-04-23');
    assert.deepEqual(records[0].parcels.cadastrals, ['2101/0036:0057']);
    assert.equal(records[0].municipalityName, 'Klaipėdos m.');
  });

  it('filters a mixed WordPress feed by what the post says', async () => {
    const posts = [
      {
        date: '2026-07-27T10:00:00',
        link: 'https://rietavas.lt/a',
        title: { rendered: 'Pagrindinės žemės naudojimo paskirties ir (ar) būdo pakeitimas' },
        content: { rendered: '<p>Gautas prašymas, kadastro Nr. 6857/0001:189</p>' },
      },
      {
        date: '2026-07-27T09:00:00',
        link: 'https://rietavas.lt/b',
        title: { rendered: 'Skelbiamas nenaudojamų, apleistų sklypų sąrašas' },
        content: { rendered: '<p>kadastro Nr. 6860/0013:231</p>' },
      },
    ];
    const source = MUNICIPAL_SOURCES.find((s) => s.slug === 'rietavo')!;
    let call = 0;
    const { records } = await fetchMunicipalSource(source, async () =>
      JSON.stringify(call++ === 0 ? posts : []),
    );
    assert.equal(records.length, 1, 'the neglected-plot notice must not be collected');
    assert.deepEqual(records[0].parcels.cadastrals, ['6857/0001:0189']);
    assert.equal(records[0].publishedAt, '2026-07-27');
  });

  it('fails the run when the upstream refuses most of a listing', async () => {
    // Silently skipping refusals is how two thirds of a municipality vanish
    // while the run still reports success.
    const source = {
      ...MUNICIPAL_SOURCES.find((s) => s.slug === 'alytaus_raj')!,
      requestDelayMs: 0,
    };
    const listing = Array.from(
      { length: 4 },
      (_, i) =>
        `<a href="/pagrindines/zemes-naudojimo-paskirties-keitimo-skelbimai/1198/notice-${i}:${i}">x</a>`,
    ).join('');

    const isNotice = (url: string) => /notice-\d+:\d+$/.test(url);
    const { stats } = await fetchMunicipalSource(source, async (url) =>
      isNotice(url) ? '<h1>Įvyko klaida..</h1><p>nurodydami bylos numerį</p>' : page(listing),
    );
    assert.match(stats[0].error ?? '', /refused most of the listing/);
  });
});
