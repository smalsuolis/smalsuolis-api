import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractParcelIds,
  normalizeCadastral,
  normalizeUniqueNumber,
  hasParcelId,
  ParcelIds,
} from '../../utils/savivaldybeZemetvarka/cadastral';
import {
  extractDates,
  extractDatesFromHrefs,
  extractDeadlineDates,
  extractWorkingDayWindow,
  subtractWorkingDays,
  splitDates,
} from '../../utils/savivaldybeZemetvarka/dates';
import {
  classifyKind,
  flattenBlocks,
  groupRecords,
  parsePortalPage,
  pickNoticeUrl,
  syntheticId,
  isDateHeading,
} from '../../utils/savivaldybeZemetvarka/records';
import {
  parseMunicipalityIndex,
  parseNoticePagePaths,
} from '../../utils/savivaldybeZemetvarka/portal';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', `${name}.excerpt.html`), 'utf-8');

describe('parcel identifiers', () => {
  describe('cadastral numbers', () => {
    it('pads every group to four digits', () => {
      assert.equal(normalizeCadastral('5247/0011:199'), '5247/0011:0199');
      assert.equal(normalizeCadastral('8730/0002:0248'), '8730/0002:0248');
    });

    it('accepts the spacing municipalities actually use', () => {
      assert.equal(normalizeCadastral('6860/0013: 115'), '6860/0013:0115');
      assert.equal(normalizeCadastral('4337 / 0005 : 391'), '4337/0005:0391');
    });

    it('collapses two spellings of one parcel to one key', () => {
      assert.equal(normalizeCadastral('4374/0001:63'), normalizeCadastral('4374/0001:0063'));
    });

    it('reads them out of the wording each municipality uses', () => {
      for (const label of ['kadastro Nr.', 'kadastrinis Nr.', 'kad. Nr.', 'KAD.NR.', 'KAD., NR.']) {
        assert.deepEqual(
          extractParcelIds(`sklypo (${label} 2901/0023:458), Šiauliuose`).cadastrals,
          ['2901/0023:0458'],
          label,
        );
      }
    });
  });

  describe('unique numbers', () => {
    it('drops the separators for the registry lookup', () => {
      assert.equal(normalizeUniqueNumber('7240-0001-0086'), '724000010086');
      assert.equal(normalizeUniqueNumber('4400-0031-3262'), '440000313262');
    });

    it('is never rewritten into a cadastral number', () => {
      // 7213-0002-0086 reformatted as 7213/0002:0086 names a parcel that does
      // not exist — the registry answers this lookup with 7213/0005:0086.
      const { cadastrals, uniqueNumbers } = extractParcelIds('(unikalus Nr.7213-0002-0086)');
      assert.deepEqual(cadastrals, []);
      assert.deepEqual(uniqueNumbers, ['721300020086']);
    });
  });

  describe('telling them apart from dates', () => {
    it('does not read an ISO date as a unique number', () => {
      // A 4-1..4-1..4 pattern matches every ISO date on the page; these pages
      // carry hundreds, so the loose form silently fills the parcel list with
      // dates and makes every derived id unstable.
      const ids = extractParcelIds('Paskelbta 2023-01-05, atnaujinta 2026-08-27.');
      assert.deepEqual(ids.cadastrals, []);
      assert.deepEqual(ids.uniqueNumbers, []);
      assert.equal(hasParcelId('2023-01-05'), false);
    });

    it('still finds a real unique number next to a date', () => {
      const ids = extractParcelIds('2026-08-21 unikalus Nr. 4400-0031-3262');
      assert.deepEqual(ids.uniqueNumbers, ['440000313262']);
    });
  });

  it('sorts and de-duplicates so order of appearance cannot leak in', () => {
    const a = extractParcelIds('sklypai 4337/0005:391 ir 4337/0005:390');
    const b = extractParcelIds('sklypai 4337/0005:390, 4337/0005:391 (kad. Nr. 4337/0005:391)');
    assert.deepEqual(a.cadastrals, b.cadastrals);
  });
});

describe('dates', () => {
  it('reads the ISO form', () => {
    assert.deepEqual(extractDates('Paskelbta 2026-08-21.'), ['2026-08-21']);
  });

  it('reads the Lithuanian long form', () => {
    // Zarasai and Radviliškis write only this form; an ISO-only reader reports
    // their newest notice as years old.
    assert.deepEqual(extractDates('2026 m. birželio 3 d.'), ['2026-06-03']);
    assert.deepEqual(extractDates('2022 m. kovo 29 d. yra gautas'), ['2022-03-29']);
  });

  it('reads both forms out of one record', () => {
    assert.deepEqual(
      extractDates('2022-03-23 — informuojame, kad 2022 m. kovo 23 d. gautas prašymas'),
      ['2022-03-23'],
    );
  });

  it('rejects impossible dates', () => {
    assert.deepEqual(extractDates('2026-13-45'), []);
    assert.deepEqual(extractDates('2026-02-30'), []);
  });

  it('recovers dates from PDF upload paths', () => {
    // Biržai puts almost no dates in the page text; they survive only here.
    assert.deepEqual(extractDatesFromHrefs(['/sites/default/files/uploads/2026/07/prasymas.pdf']), [
      '2026-07-01',
    ]);
  });

  describe('publication versus deadline', () => {
    it('treats a date introduced by "iki" as the deadline', () => {
      assert.deepEqual(extractDeadlineDates('(iki 2026-09-04) galite teikti pasiūlymus'), [
        '2026-09-04',
      ]);
    });

    it('reads the stated comment window', () => {
      assert.equal(extractWorkingDayWindow('10 d. d. nuo prašymo paskelbimo datos'), 10);
      assert.equal(extractWorkingDayWindow('10 darbo dienų nuo paskelbimo'), 10);
      assert.equal(extractWorkingDayWindow('jokio lango'), null);
    });

    it('steps back over weekends', () => {
      // 2026-09-04 is a Friday; ten working days earlier is 2026-08-21.
      assert.equal(subtractWorkingDays('2026-09-04', 10), '2026-08-21');
    });

    it('prefers a heading date over anything in the prose', () => {
      const r = splitDates(['2022-03-23', '2022-04-10'], { headingDate: '2022-03-23' });
      assert.equal(r.publishedAt, '2022-03-23');
      assert.equal(r.deadlineAt, '2022-04-10');
    });

    it('takes the earliest date, not the newest, when there is no heading', () => {
      // The deadline is always the larger number, so "newest date on the page"
      // picks exactly the wrong one.
      const r = splitDates(['2026-06-03', '2026-06-17'], {});
      assert.equal(r.publishedAt, '2026-06-03');
      assert.equal(r.deadlineAt, '2026-06-17');
    });

    it('derives publication from a deadline-only record', () => {
      // Raseiniai never prints the publication date, only the window's close.
      const text = '10 d. d. nuo prašymo paskelbimo datos (iki 2026-09-04) galite teikti';
      const r = splitDates(extractDates(text), { text });
      assert.equal(r.deadlineAt, '2026-09-04');
      assert.equal(r.publishedAt, '2026-08-21');
      assert.equal(r.publishedAtDerived, true);
    });

    it('ignores statute references older than the publication duty', () => {
      const r = splitDates(['1999-09-29', '2026-06-03'], {});
      assert.equal(r.publishedAt, '2026-06-03');
    });
  });
});

describe('date headings', () => {
  it('recognises a block that is nothing but a date', () => {
    assert.equal(isDateHeading('2022-03-23'), true);
    assert.equal(isDateHeading('2026 m. birželio 3 d.'), true);
  });

  it('does not mistake prose mentioning a date for a heading', () => {
    assert.equal(isDateHeading('Informuojame, kad 2022 m. kovo 23 d. yra gautas prašymas'), false);
  });
});

describe('request versus decision', () => {
  it('reads the legal formula, not the layout', () => {
    assert.equal(
      classifyKind('Informuojame, kad yra pateiktas prašymas dėl žemės sklypo'),
      'request',
    );
    assert.equal(
      classifyKind('Vadovaudamasis įstatymu, pakeičiu žemės sklypo paskirtį'),
      'decision',
    );
  });
});

describe('synthetic id', () => {
  const parcels: ParcelIds = { cadastrals: ['4337/0005:0391'], uniqueNumbers: [] };

  it('is stable for the same notice', () => {
    assert.equal(
      syntheticId('zarasu_raj', parcels, '2022-03-23', 'request'),
      syntheticId('zarasu_raj', parcels, '2022-03-23', 'request'),
    );
  });

  it('ignores the order parcels were written in', () => {
    const a = extractParcelIds('4337/0005:391 ir 4337/0005:390');
    const b = extractParcelIds('4337/0005:390 ir 4337/0005:391');
    assert.equal(
      syntheticId('zarasu_raj', a, '2022-03-23'),
      syntheticId('zarasu_raj', b, '2022-03-23'),
    );
  });

  it('separates notices that differ in what they are', () => {
    const date = '2024-06-17';
    assert.notEqual(
      syntheticId('siauliu_m', parcels, date, 'request'),
      syntheticId('siauliu_m', parcels, date, 'decision'),
    );
    assert.notEqual(
      syntheticId('siauliu_m', parcels, date, 'request'),
      syntheticId('kauno_raj', parcels, date, 'request'),
    );
  });
});

describe('parsing real portal pages', () => {
  it('reads a page whose records are introduced by a date heading', () => {
    const records = parsePortalPage(fixture('zarasu_raj'), 'zarasu_raj');
    assert.ok(records.length > 0, 'expected records');

    const record = records.find((r) => r.parcels.cadastrals.includes('4374/0001:0063'));
    assert.ok(record, 'expected the 4374/0001:63 notice');
    assert.equal(record!.publishedAt, '2022-01-11');
    // The heading and the sentence below it both name the parcel; that is one
    // notice, not two.
    assert.equal(records.filter((r) => r.syntheticId === record!.syntheticId).length, 1);
  });

  it('reads a page that gives only unique numbers and only a deadline', () => {
    const records = parsePortalPage(fixture('raseiniu_raj'), 'raseiniu_raj');
    const record = records.find((r) => r.parcels.uniqueNumbers.includes('726000040076'));
    assert.ok(record, 'expected the 7260-0004-0076 notice');
    assert.deepEqual(record!.parcels.cadastrals, [], 'unique numbers must not become cadastrals');
    assert.equal(record!.deadlineAt, '2026-09-04');
    assert.equal(record!.publishedAt, '2026-08-21');
  });

  it('reads a page whose dates live only in PDF links', () => {
    const records = parsePortalPage(fixture('birzu_raj'), 'birzu_raj');
    assert.ok(records.length > 0, 'expected records');
    assert.ok(
      records.some((r) => r.publishedAt?.startsWith('2026')),
      'expected a 2026 date recovered from an upload path',
    );
  });

  it('gives every record a distinct id', () => {
    for (const name of ['zarasu_raj', 'raseiniu_raj', 'birzu_raj']) {
      const records = parsePortalPage(fixture(name), name);
      const ids = new Set(records.map((r) => r.syntheticId));
      assert.equal(ids.size, records.length, `${name} produced colliding ids`);
    }
  });

  it('keeps ids unchanged when the page is edited around the notices', () => {
    // Pages are re-ordered and re-worded in place constantly. An id that moves
    // when they are means every run re-inserts every notice.
    const html = fixture('zarasu_raj');
    const before = parsePortalPage(html, 'zarasu_raj')
      .map((r) => r.syntheticId)
      .sort();

    const edited = html
      .replace(/Informuojame/g, 'Pranešame')
      .replace(/<p>/g, '<p >')
      .replace('</div>', '<p>Papildoma pastaba redaktoriaus.</p></div>');
    const after = parsePortalPage(edited, 'zarasu_raj')
      .map((r) => r.syntheticId)
      .sort();

    assert.deepEqual(after, before);
  });
});

describe('finding the notice pages', () => {
  it('reads every municipality out of the index', () => {
    const sections = parseMunicipalityIndex(fixture('portal-index'));
    assert.equal(sections.length, 60, 'Lithuania has 60 municipalities');

    const zarasai = sections.find((s) => s.slug === 'zarasu_raj');
    assert.equal(zarasai?.name, 'Zarasų raj.');
    assert.equal(zarasai?.path, '/lt/planuoju_rtpd/zarasu_raj');
  });

  it('does not count the index page as a municipality', () => {
    const sections = parseMunicipalityIndex(fixture('portal-index'));
    assert.ok(!sections.some((s) => s.slug === 'savivaldybes_vietoves_lygmens_tpd'));
  });

  it('keeps a municipality whose own slug is misspelled', () => {
    // The portal writes Ignalina's slug as `ignalinos_jar`. Deriving slugs from
    // names instead of reading them would silently drop it.
    const sections = parseMunicipalityIndex(fixture('portal-index'));
    assert.ok(sections.some((s) => s.slug === 'ignalinos_jar'));
  });

  it('returns every notice page a municipality has, not just the first', () => {
    // Kauno r. has seven; the current notices are in the last of them, and the
    // names give no reliable ordering (`pagal_20_2_2_iki_nuo_2026`).
    const paths = parseNoticePagePaths(fixture('portal-section'), 'kauno_raj');
    assert.equal(paths.length, 7);
    assert.ok(paths.includes('/lt/planuoju_rtpd/kauno_raj/pagal_20_2_2_iki_nuo_2026'));
  });

  it('ignores the other document types in the same section', () => {
    const paths = parseNoticePagePaths(fixture('portal-section'), 'kauno_raj');
    assert.ok(paths.every((p) => /pagal_20_2_2/.test(p)));
    assert.ok(!paths.some((p) => /detalieji|kor_28_9|specialieji|bendrieji/.test(p)));
  });
});

describe('links written as absolute URLs', () => {
  // Vilniaus r. links its six older notice pages relatively and the current one
  // absolutely. Matching only relative hrefs drops the 1.3 MB page holding
  // every 2026 notice, and the municipality reads as silent.
  const html = `<div class="field field--name-body field--item"><ul>
    <li><a href="/planuoju_rtpd/vilniaus_raj/pagal_20_2_2_nuo_202401">senas</a></li>
    <li><a href="https://www.planuojustatau.lt/planuoju_rtpd/vilniaus_raj/pagal_20_2_2_nuo_20250102">naujas</a></li>
  </ul></div>`;

  it('finds a notice page linked absolutely', () => {
    const paths = parseNoticePagePaths(html, 'vilniaus_raj');
    assert.equal(paths.length, 2);
    assert.ok(paths.includes('/lt/planuoju_rtpd/vilniaus_raj/pagal_20_2_2_nuo_20250102'));
  });

  it('finds a municipality linked absolutely', () => {
    const index = `<div class="field field--name-body field--item">
      <a href="https://www.planuojustatau.lt/planuoju_rtpd/zarasu_raj">Zarasų raj.</a></div>`;
    assert.deepEqual(
      parseMunicipalityIndex(index).map((s) => s.slug),
      ['zarasu_raj'],
    );
  });
});

describe('HTML pasted out of Word', () => {
  // These pages are authored by pasting from Word, which emits a paragraph
  // nested inside a paragraph. Treating only childless elements as blocks threw
  // the date away with the wrapper: Vilkaviškio r.'s 996 KB page read as 89
  // notices ending 2024-12-20 when it holds 142 ending 2026-08-17 — a
  // municipality that looked like it had gone quiet while still publishing.
  const nested = `<div class="field--name-body">
    <table><tr><td><p class="MsoNormal"><b><span>Data</span></b></p></td></tr>
    <tr><td><p class="MsoNormal"><b><span>2026-08-17<p></p></span></b></p></td></tr>
    <tr><td><p class="MsoNormal"><span>DĖL ŽEMĖS SKLYPO (KADASTRO NR. 3905/0009:4243)
      PASKIRTIES PAKEITIMO<p></p></span></p></td></tr></table>
  </div>`;

  it('keeps text a nested paragraph would otherwise swallow', () => {
    const texts = flattenBlocks(nested).map((b) => b.text);
    assert.ok(
      texts.some((t) => t.includes('2026-08-17')),
      'the date must survive the Word wrapper',
    );
  });

  it('does not repeat a wrapper’s text through its children', () => {
    // The other half of the same rule: a block carries only what it owns, so a
    // parcel mentioned once is not counted several times up the tree.
    const records = parsePortalPage(nested, 'vilkaviskiu_raj');
    assert.equal(records.length, 1);
    assert.equal(records[0].publishedAt, '2026-08-17');
    assert.deepEqual(records[0].parcels.cadastrals, ['3905/0009:4243']);
  });
});

describe('dates a notice merely cites', () => {
  // A notice routinely cites the decision or plan it acts under. Those dates are
  // older than the notice, so taking the earliest plausible date picked the
  // citation: a 2026 notice was dated 2023, and the mixin then treated it as
  // historical, stamping created_at in 2023 — the notice reached nobody.
  const text =
    'Vadovaudamasis Tarybos 2023 m. gegužės 12 d. sprendimu Nr. T-118, informuojame, ' +
    'kad 2026-08-17 gautas prašymas pakeisti žemės sklypo (kadastro Nr. 3905/0009:4243) paskirtį.';

  it('does not date a notice by the decision it cites', () => {
    const r = splitDates(extractDates(text), { text });
    assert.equal(r.publishedAt, '2026-08-17');
  });

  it('still prefers a heading date over anything in the prose', () => {
    const r = splitDates(extractDates(text), { text, headingDate: '2026-08-18' });
    assert.equal(r.publishedAt, '2026-08-18');
  });
});

describe('dates recovered from a PDF link', () => {
  it('never becomes a deadline the notice did not state', () => {
    // An upload path pins only a year and month, so it cannot mark the close of
    // a comment period. Treated as one, a notice dated 2026-01-15 with a
    // /uploads/2026/03/ attachment advertised "Pasiūlymai iki: 2026-03-01".
    const records = groupRecords([
      { text: '2026-01-15', hrefs: [] },
      {
        text: 'Gautas prašymas dėl žemės sklypo (kadastro Nr. 3905/0009:4243) paskirties keitimo',
        hrefs: ['/sites/default/files/uploads/2026/03/prasymas.pdf'],
      },
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].publishedAt, '2026-01-15');
    assert.equal(records[0].deadlineAt, null, 'an upload path is not a stated deadline');
  });

  it('still dates a notice whose only date is in the upload path', () => {
    const records = groupRecords([
      {
        text: 'Informacija apie žemės sklypą (kadastro Nr. 3905/0009:4243)',
        hrefs: ['/sites/default/files/uploads/2026/07/prasymas.pdf'],
      },
    ]);
    assert.equal(records[0].publishedAt, '2026-07-01');
  });
});

describe('a decision the notice is about, not one it cites', () => {
  it('keeps the date of the order the notice announces', () => {
    // Šiauliai publishes decisions as "Informuojame apie 2026-07-01 priimtą …
    // mero potvarkį M-930". That date IS the notice's. Treating every date near
    // the word "potvarkis" as a citation left 1,355 records undated across the
    // country, and an undated record becomes no event at all.
    const text =
      'Informuojame apie 2026-07-01 priimtą Šiaulių miesto savivaldybės mero potvarkį M-930 ' +
      '„Dėl žemės sklypo Draugystės pr. 18 (kadastro Nr. 2901/0012:402) naudojimo būdo pakeitimo“';
    const r = splitDates(extractDates(text), { text });
    assert.equal(r.publishedAt, '2026-07-01');
  });

  it('still drops the date of a decision the notice acts under', () => {
    const text =
      'Vadovaudamasis Tarybos 2023 m. gegužės 12 d. sprendimu Nr. T-118, informuojame, ' +
      'kad 2026-08-17 gautas prašymas (kadastro Nr. 3905/0009:4243).';
    const r = splitDates(extractDates(text), { text });
    assert.equal(r.publishedAt, '2026-08-17');
  });
});

describe('linking a reader to the notice itself', () => {
  const page = 'https://www.planuojustatau.lt/lt/planuoju_rtpd/vilniaus_m/pagal_20_2_2_nuo_202401';

  it('prefers the municipality page over the cumulative portal page', () => {
    // The portal keeps every notice on one page, so linking there drops a
    // reader into hundreds of unrelated notices.
    const hrefs = [
      'https://vilnius.lt/rest//assets/5753886e.pdf',
      'https://vilnius.lt/naujienos/informacija-apie-zemes-sklypo-kadastro-nr-010101590279',
      'mailto:savivaldybe@vilnius.lt',
    ];
    assert.equal(
      pickNoticeUrl(hrefs, page),
      'https://vilnius.lt/naujienos/informacija-apie-zemes-sklypo-kadastro-nr-010101590279',
    );
  });

  it('rejects a bare homepage', () => {
    // Several municipalities link only their front page, which tells a reader
    // less than the portal page does.
    assert.equal(pickNoticeUrl(['http://www.vilkaviskis.lt'], page), page);
    assert.equal(pickNoticeUrl(['http://www.siauliai.lt/'], page), page);
  });

  it('rejects attachments, including an extension mid-path', () => {
    // Document stores hang an id after the extension.
    assert.equal(pickNoticeUrl(['https://x.lt/a/2024-06-03+M-734.pdf/b053f1'], page), page);
    assert.equal(pickNoticeUrl(['https://vilnius.lt/rest//assets/a.jpg'], page), page);
  });

  it('ignores the portal linking back to itself, and non-http links', () => {
    assert.equal(pickNoticeUrl(['https://www.planuojustatau.lt/lt/kita'], page), page);
    assert.equal(pickNoticeUrl(['/relative/path', 'mailto:a@b.lt'], page), page);
  });

  it('falls back to the page when the notice links nothing', () => {
    assert.equal(pickNoticeUrl([], page), page);
  });
});
