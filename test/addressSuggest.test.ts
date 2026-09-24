import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '../utils/boundaries';
import {
  buildAddressFilters,
  buildLabel,
  buildNameFilters,
  clearCodeCache,
  CodeSet,
  collectCodes,
  WalkGuard,
  isSearchableName,
  localityStem,
  orderByPlaceKind,
  orderMunicipalities,
  parseAddressInput,
  rankByPlace,
  resolveCodes,
  spreadByPlace,
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

  it('keeps the place named after the first comma', () => {
    assert.deepEqual(parseAddressInput('Vilniaus g. 2, Kaunas'), {
      street: 'Vilniaus g.',
      houseNumber: '2',
      locality: 'Kaunas',
    });
    assert.deepEqual(parseAddressInput('Kaltinėnų mstl., Šilalės r.'), {
      street: 'Kaltinėnų mstl.',
      locality: 'Šilalės r.',
    });
  });

  it('does not read a numbered street name as a house number', () => {
    // The registry has no such split for "Kalno 3-oji g." — the trailing token
    // must start with a digit AND end the input.
    assert.deepEqual(parseAddressInput('Kalno 3-oji g.'), { street: 'Kalno 3-oji g.' });
  });
});

describe('isSearchableName', () => {
  it('refuses a name the registry would read as "everything"', () => {
    // The endpoint's min:3 counts the comma, so these reach the search.
    for (const input of [', ab', ',,,', 'a 1', '%%%', '  x  ']) {
      assert.equal(isSearchableName(parseAddressInput(input).street), false, input);
    }
  });

  it('keeps the shortest fragment worth searching for', () => {
    for (const input of ['Ged', 'sod', 'J. B. g.', 'Vilniaus g. 2']) {
      assert.equal(isSearchableName(parseAddressInput(input).street), true, input);
    }
  });
});

describe('localityStem', () => {
  it('cuts the nominative ending the registry never uses', () => {
    // The registry holds "Vilniaus m. sav.", "Kauno m. sav.", "Jurbarko r. sav."
    for (const [typed, stem] of [
      ['Vilnius', 'Viln'],
      ['Kaunas', 'Kaun'],
      ['Jurbarkas', 'Jurbark'],
      ['Klaipėda', 'Klaipėd'],
      // Plural nominatives need the whole ending gone: "Šiaulių", not "Šiaulia".
      ['Šiauliai', 'Šiaul'],
      ['Panevėžys', 'Panevėž'],
      ['Alytus', 'Alyt'],
    ] as const) {
      assert.equal(localityStem(typed), stem, typed);
    }
  });

  it('drops the kind the registry spells out itself', () => {
    assert.equal(localityStem('Šilalės r.'), 'Šilal');
    assert.equal(localityStem('Vilniaus m.'), 'Viln');
  });

  it('keeps a name too short to cut', () => {
    assert.equal(localityStem('Ada'), 'Ada');
  });
});

describe('rankByPlace', () => {
  it('puts the town ahead of the village', () => {
    const village = address({ residential_area: { code: 1, feature_id: 1, name: 'Škėvonių k.' } });
    const city = address({ residential_area: { code: 2, feature_id: 2, name: 'Vilniaus m.' } });
    const town = address({ residential_area: { code: 3, feature_id: 3, name: 'Kamajų mstl.' } });

    assert.deepEqual(
      rankByPlace([village, city, town]).map((a) => a.residential_area?.name),
      ['Vilniaus m.', 'Kamajų mstl.', 'Škėvonių k.'],
    );
  });

  it('reads the named place in the order its codes were resolved in', () => {
    const district = address({
      municipality: {
        code: 41,
        feature_id: 9,
        name: 'Vilniaus r. sav.',
        county: { code: 10, feature_id: 1, name: 'Vilniaus apskr.' },
      },
      residential_area: { code: 1, feature_id: 1, name: 'Nemenčinės m.' },
    });
    const city = address();

    assert.deepEqual(
      rankByPlace([district, city], [13, 41]).map((a) => a.municipality?.name),
      ['Vilniaus m. sav.', 'Vilniaus r. sav.'],
    );
  });

  it('prefers a city municipality when no place was named', () => {
    const district = address({
      municipality: {
        code: 41,
        feature_id: 9,
        name: 'Biržų r. sav.',
        county: { code: 10, feature_id: 1, name: 'Vilniaus apskr.' },
      },
      residential_area: { code: 1, feature_id: 1, name: 'Biržų m.' },
    });
    const city = address();

    assert.deepEqual(
      rankByPlace([district, city]).map((a) => a.municipality?.name),
      ['Vilniaus m. sav.', 'Biržų r. sav.'],
    );
  });

  it('leaves rows it cannot place at the end, in the order they came', () => {
    const unknown = address({ residential_area: null });
    const city = address({ residential_area: { code: 2, feature_id: 2, name: 'Vilniaus m.' } });

    assert.deepEqual(
      rankByPlace([unknown, city]).map((a) => a.residential_area?.name ?? null),
      ['Vilniaus m.', null],
    );
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

  it('names the settlement that tells two rows apart', () => {
    const label = buildLabel(
      address({
        street: { code: 1, feature_id: 1, name: 'Lauko g.', full_name: 'Lauko g.' },
        plot_or_building_number: '6',
        residential_area: { code: 9, feature_id: 9, name: 'Skirsnemunės k.' },
        municipality: {
          code: 55,
          feature_id: 9,
          name: 'Jurbarko r. sav.',
          county: { code: 10, feature_id: 1, name: 'Vilniaus apskr.' },
        },
      }),
    );
    assert.equal(label, 'Lauko g. 6, Skirsnemunės k., Jurbarko r. sav.');
  });

  it('leaves out a settlement that only says the municipality again', () => {
    // "Vilniaus m." inside "Vilniaus m. sav." tells a reader nothing new.
    assert.equal(buildLabel(address()), 'Gedimino pr. 38, Vilniaus m. sav.');
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

  it('narrows both branches by the place someone named', () => {
    // By code, not by name: filtering addresses on a joined municipality NAME is
    // the same full scan the code lookup exists to avoid.
    assert.deepEqual(
      buildAddressFilters({ streetCodes: [1], areaCodes: [9], municipalityCodes: [13] }),
      [
        { streets: { codes: [1] }, municipalities: { codes: [13] } },
        { residential_areas: { codes: [9] }, municipalities: { codes: [13] } },
      ],
    );
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

  it('narrows both branches by the resolved place', () => {
    assert.deepEqual(buildNameFilters('Sodo g.', undefined, [13]), [
      { streets: { name: { contains: 'Sodo g.' } }, municipalities: { codes: [13] } },
      { residential_areas: { name: { contains: 'Sodo g.' } }, municipalities: { codes: [13] } },
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

describe('orderMunicipalities', () => {
  const found = [
    {
      code: 41,
      name: 'Vilniaus r. sav.',
      county: { code: 10, feature_id: 1, name: 'Vilniaus apskr.' },
    },
    { code: 13, name: 'Vilniaus m. sav.' },
  ];

  it('reads a bare city name as the city, not the district around it', () => {
    assert.deepEqual(orderMunicipalities(found, 'Vilnius'), [13, 41]);
  });

  it('honours the kind when it was typed', () => {
    assert.deepEqual(orderMunicipalities(found, 'Vilniaus r.'), [41, 13]);
    assert.deepEqual(orderMunicipalities(found, 'Vilniaus m. sav.'), [13, 41]);
  });
});

describe('orderByPlaceKind', () => {
  const rows = [
    { code: 1, residential_area: { name: 'Škėvonių k.' } },
    { code: 2, residential_area: { name: 'Grigiškių m.' } },
    { code: 3, residential_area: { name: 'Vilniaus m.' } },
    { code: 4, residential_area: { name: 'Kamajų mstl.' } },
  ];

  it('asks about the cities first, then the towns, then the villages', () => {
    assert.deepEqual(orderByPlaceKind(rows, ['Vilniaus m.']), [3, 2, 4, 1]);
  });

  it('ranks a settlement row by its own name', () => {
    assert.deepEqual(
      orderByPlaceKind([{ code: 7, name: 'Kaltinėnų mstl.' }, ...rows]),
      [2, 3, 7, 4, 1],
    );
  });
});

describe('spreadByPlace', () => {
  it('gives every place a row before repeating one', () => {
    const rows = [
      address({ residential_area: { code: 1, feature_id: 1, name: 'Šiaulių m.' } }),
      address({ residential_area: { code: 1, feature_id: 1, name: 'Šiaulių m.' } }),
      address({ residential_area: { code: 2, feature_id: 2, name: 'Vilniaus m.' } }),
    ];

    assert.deepEqual(
      spreadByPlace(rows).map((a) => a.residential_area?.name),
      ['Šiaulių m.', 'Vilniaus m.', 'Šiaulių m.'],
    );
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

describe('resolveCodes', () => {
  it('asks the registry once for a name it has already resolved', async () => {
    clearCodeCache();
    let calls = 0;
    const resolve = async (): Promise<CodeSet> => {
      calls++;
      return { codes: [1, 2], complete: true };
    };

    assert.deepEqual(await resolveCodes('street:gedimino pr.', resolve), {
      codes: [1, 2],
      complete: true,
    });
    assert.deepEqual(await resolveCodes('street:gedimino pr.', resolve), {
      codes: [1, 2],
      complete: true,
    });
    assert.equal(calls, 1, 'the second lookup must not reach the registry');
  });

  it('keeps street and area answers apart', async () => {
    clearCodeCache();
    await resolveCodes('street:sodu g.', async () => ({ codes: [7], complete: true }));
    const area = await resolveCodes('area:sodu g.', async () => ({ codes: [9], complete: true }));
    assert.deepEqual(area.codes, [9]);
  });

  // A give-up is either "too many matches" or a registry 500, and the two are
  // indistinguishable here. Caching it would pin the slow path for a whole day.
  it('never caches a set it gave up on', async () => {
    clearCodeCache();
    let calls = 0;
    const resolve = async (): Promise<CodeSet> => {
      calls++;
      return { codes: [], complete: false };
    };

    await resolveCodes('street:sod', resolve);
    await resolveCodes('street:sod', resolve);
    assert.equal(calls, 2, 'an incomplete set must be retried, not remembered');
  });

  it('retries a name the registry failed on, and keeps the answer once it works', async () => {
    clearCodeCache();
    let calls = 0;
    const resolve = async (): Promise<CodeSet> => {
      calls++;
      return calls === 1 ? { codes: [], complete: false } : { codes: [42], complete: true };
    };

    assert.deepEqual((await resolveCodes('street:vilniaus g.', resolve)).codes, []);
    assert.deepEqual((await resolveCodes('street:vilniaus g.', resolve)).codes, [42]);
    assert.deepEqual((await resolveCodes('street:vilniaus g.', resolve)).codes, [42]);
    assert.equal(calls, 2);
  });
});
