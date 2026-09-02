import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '../utils/boundaries';
import {
  buildAddressFilters,
  buildLabel,
  buildNameFilters,
  collectCodes,
  WalkGuard,
  parseAddressInput,
  toSuggestions,
} from '../utils/addressSuggest';

const page = (codes: number[], total: number, nextPage: string | null = null) => ({
  items: codes.map((code) => ({ code })),
  total,
  next_page: nextPage,
});

const codeRange = (count: number, from = 1) => Array.from({ length: count }, (_, i) => i + from);

const address = (overrides: Partial<Address> = {}): Address => ({
  code: 156750711,
  feature_id: 123351,
  plot_or_building_number: '38',
  building_block_number: null,
  postal_code: 'LT-01104',
  street: { code: 1214286, feature_id: 17078, name: 'Gedimino pr.', full_name: 'Gedimino pr.' },
  residential_area: { code: 31003, feature_id: 17552, name: 'Vilniaus m.' },
  municipality: {
    code: 13,
    feature_id: 8,
    name: 'Vilniaus m. sav.',
    county: { code: 10, feature_id: 1, name: 'Vilniaus apskr.' },
  },
  geometry: { srid: 4326, data: 'SRID=4326;POINT(25.27242006085645 54.68819606376946)' },
  ...overrides,
});

describe('parseAddressInput', () => {
  it('keeps a bare street name whole', () => {
    assert.deepEqual(parseAddressInput('Gedimino'), { street: 'Gedimino' });
    assert.deepEqual(parseAddressInput('Vilniaus g.'), { street: 'Vilniaus g.' });
  });

  it('splits off a trailing house number', () => {
    assert.deepEqual(parseAddressInput('Vilniaus g. 2'), {
      street: 'Vilniaus g.',
      houseNumber: '2',
    });
  });

  it('keeps a letter or dash suffix with the number', () => {
    assert.deepEqual(parseAddressInput('Vilniaus g. 22A'), {
      street: 'Vilniaus g.',
      houseNumber: '22A',
    });
    assert.deepEqual(parseAddressInput('Vilniaus g. 2-1'), {
      street: 'Vilniaus g.',
      houseNumber: '2-1',
    });
  });

  it('drops the locality hint after the first comma', () => {
    assert.deepEqual(parseAddressInput('Vilniaus g. 2, Kaunas'), {
      street: 'Vilniaus g.',
      houseNumber: '2',
    });
    assert.deepEqual(parseAddressInput('Kaltinėnų mstl., Šilalės r.'), {
      street: 'Kaltinėnų mstl.',
    });
  });

  it('does not read a numbered street name as a house number', () => {
    // The registry has no such split for "Kalno 3-oji g." — the trailing token
    // must start with a digit AND end the input.
    assert.deepEqual(parseAddressInput('Kalno 3-oji g.'), { street: 'Kalno 3-oji g.' });
  });
});

describe('buildLabel', () => {
  it('prefers the street full name', () => {
    const label = buildLabel(
      address({
        street: { code: 1, feature_id: 1, name: 'Gedimino', full_name: 'Gedimino pr.' },
      }),
    );
    assert.equal(label, 'Gedimino pr. 38, Vilniaus m. sav.');
  });

  it('falls back to the residential area when there is no street', () => {
    const label = buildLabel(address({ street: null, plot_or_building_number: '5' }));
    assert.equal(label, 'Vilniaus m. 5, Vilniaus m. sav.');
  });

  it('never starts with a stray comma when nothing names the place', () => {
    const label = buildLabel(
      address({ street: null, residential_area: null, plot_or_building_number: '' }),
    );
    assert.equal(label, 'Vilniaus m. sav.');
  });
});

describe('buildAddressFilters', () => {
  it('ORs the street and residential-area branches', () => {
    assert.deepEqual(buildAddressFilters({ streetCodes: [1, 2], areaCodes: [9] }), [
      { streets: { codes: [1, 2] } },
      { residential_areas: { codes: [9] } },
    ]);
  });

  it('narrows only the street branch by house number', () => {
    assert.deepEqual(buildAddressFilters({ streetCodes: [1], areaCodes: [9], houseNumber: '2' }), [
      {
        streets: { codes: [1] },
        addresses: { plot_or_building_number: { starts: '2' } },
      },
      { residential_areas: { codes: [9] } },
    ]);
  });

  it('drops a branch whose name matched nothing', () => {
    assert.deepEqual(buildAddressFilters({ streetCodes: [1], areaCodes: [] }), [
      { streets: { codes: [1] } },
    ]);
    assert.deepEqual(buildAddressFilters({ streetCodes: [], areaCodes: [9] }), [
      { residential_areas: { codes: [9] } },
    ]);
  });

  it('returns nothing when neither name matched', () => {
    // The registry reads `filters: []` as "no filter" and answers with the first
    // page of all 1.1M addresses, so the caller must not search on an empty list.
    assert.deepEqual(buildAddressFilters({ streetCodes: [], areaCodes: [] }), []);
  });
});

describe('toSuggestions', () => {
  it('converts the registry WKT into a GeoJSON point', () => {
    assert.deepEqual(toSuggestions([address()]), [
      {
        code: 156750711,
        label: 'Gedimino pr. 38, Vilniaus m. sav.',
        geometry: { type: 'Point', coordinates: [25.27242006085645, 54.68819606376946] },
      },
    ]);
  });

  it('skips rows the map could not place', () => {
    const noGeometry = address({ code: 1, geometry: { srid: 4326, data: '' } });
    assert.deepEqual(toSuggestions([noGeometry]), []);
  });

  it('skips rows nothing could label', () => {
    const unlabelled = address({
      code: 2,
      street: null,
      residential_area: null,
      plot_or_building_number: '',
      municipality: { code: 13, feature_id: 8, name: '', county: null },
    });
    assert.deepEqual(toSuggestions([unlabelled]), []);
  });
});

describe('buildNameFilters', () => {
  it('keeps the shape the code lookup falls back to', () => {
    assert.deepEqual(buildNameFilters('Sodo g.'), [
      { streets: { name: { contains: 'Sodo g.' } } },
      { residential_areas: { name: { contains: 'Sodo g.' } } },
    ]);
  });

  it('narrows only the street branch by house number', () => {
    assert.deepEqual(buildNameFilters('Sodo g.', '1'), [
      {
        streets: { name: { contains: 'Sodo g.' } },
        addresses: { plot_or_building_number: { starts: '1' } },
      },
      { residential_areas: { name: { contains: 'Sodo g.' } } },
    ]);
  });
});

describe('collectCodes', () => {
  it('takes a short match in one request', async () => {
    let calls = 0;
    const result = await collectCodes(async () => {
      calls++;
      return page([1, 2, 3], 3);
    });
    assert.deepEqual(result, { codes: [1, 2, 3], complete: true });
    assert.equal(calls, 1);
  });

  it('walks every page of a long match', async () => {
    const pages = [page(codeRange(100), 150, 'cursor-2'), page(codeRange(50, 101), 150)];
    const result = await collectCodes(async () => pages.shift()!);
    assert.equal(result.complete, true);
    assert.equal(result.codes.length, 150);
    assert.equal(result.codes[149], 150);
  });

  it('decodes the cursor before asking for the next page', async () => {
    // The registry returns a percent-encoded cursor and the generated client
    // encodes query values again; sending it back as-is restarts the walk.
    const seen: Array<string | undefined> = [];
    const pages = [page(codeRange(100), 120, 'Pmk6MTM0NzI4NX5pOjEzNDcyODU%3D'), page([101], 120)];
    await collectCodes(async (cursor) => {
      seen.push(cursor);
      return pages.shift()!;
    });
    assert.deepEqual(seen, [undefined, 'Pmk6MTM0NzI4NX5pOjEzNDcyODU=']);
  });

  it('stops on a full page that names no successor', async () => {
    let calls = 0;
    const result = await collectCodes(async () => {
      calls++;
      return page(codeRange(100), 100);
    });
    assert.equal(calls, 1);
    assert.equal(result.complete, true);
    assert.equal(result.codes.length, 100);
  });

  it('refuses a name matching more rows than it will walk', async () => {
    let calls = 0;
    const result = await collectCodes(async () => {
      calls++;
      return page(codeRange(100), 2272, 'cursor-2');
    });
    // One request is enough to learn the total and give up — no truncated list
    // reaches the address query.
    assert.equal(calls, 1);
    assert.deepEqual(result, { codes: [], complete: false });
  });

  it('gives up when a name outruns the walk one page at a time', async () => {
    // A total the registry declines to report must not turn into an endless walk.
    let calls = 0;
    const result = await collectCodes(async () => {
      calls++;
      return page(codeRange(100), null as unknown as number, `cursor-${calls}`);
    });
    assert.equal(result.complete, false);
    assert.ok(calls <= 11, `walked ${calls} pages`);
  });

  it('gives up rather than return the pages it managed to read', async () => {
    // The registry answers 500 on some deep cursors; keeping the partial set
    // would drop every address on the streets we never reached.
    let calls = 0;
    const result = await collectCodes(async () => {
      calls++;
      if (calls > 2) throw new Error('Internal Server Error');
      return page(codeRange(100), 400, `cursor-${calls}`);
    });
    assert.deepEqual(result, { codes: [], complete: false });
  });

  it('stops walking once the sibling lookup has given up', async () => {
    // The address query needs both code sets, so the remaining pages of the
    // other walk are wasted work.
    const guard: WalkGuard = { givenUp: false };
    let streetCalls = 0;
    let areaCalls = 0;

    const [streets, areas] = await Promise.all([
      collectCodes(async () => {
        streetCalls++;
        return page(codeRange(100), 5000, 'cursor-2');
      }, guard),
      (async () => {
        // Runs after the street walk has had its turn, as it would in a real
        // interleaving of two awaited page requests.
        await new Promise((resolve) => setImmediate(resolve));
        return collectCodes(async () => {
          areaCalls++;
          return page(codeRange(100), 400, 'cursor-2');
        }, guard);
      })(),
    ]);

    assert.equal(streets.complete, false);
    assert.equal(areas.complete, false);
    assert.equal(streetCalls, 1);
    assert.equal(areaCalls, 0);
  });

  it('treats a missing total as small rather than walking forever', async () => {
    const result = await collectCodes(async () => page([7], null as unknown as number));
    assert.deepEqual(result, { codes: [7], complete: true });
  });
});
