import { wktToGeoJSON } from 'betterknown';
import {
  Address,
  AddressesSearchFilterRequest,
  addressesSearch,
  municipalitiesSearch,
  residentialAreasGetWithGeometry,
  residentialAreasSearch,
  streetsSearch,
} from './boundaries';

export interface AddressSuggestion {
  code: number;
  label: string;
  // GeoJSON Point (EPSG:4326), ready to drop into a FeatureCollection for the map.
  geometry: any;
}

// The registry caps a search page at 100 and only cursors forward.
const PAGE_SIZE = 100;
// Past this many name matches the code walk costs more round trips (~0.45s each)
// than the ~4.5s scan it replaces, and deep pages are where the registry's own
// cursor starts answering 500. Beyond this we use the scan instead.
const MAX_NAME_MATCHES = 500;
const SUGGEST_LIMIT = 8;
// One registry page, the most it will hand over at once — read whole so the
// ranking has something to choose from.
const RANKING_PAGE_SIZE = 100;
// How many of a name's places we ask about when the input names none. Twelve
// covers the seven cities with room to spare, and keeps that one page pointed at
// the places a reader meant.
const PREFERRED_CODES = 12;

// Split free-text input into the parts the registry can filter on.
// "Vilniaus g. 2, Vilnius" → { street: 'Vilniaus g.', houseNumber: '2', locality: 'Vilnius' }
// "Gedimino"              → { street: 'Gedimino' }
export const parseAddressInput = (
  input: string,
): { street: string; houseNumber?: string; locality?: string } => {
  const [beforeComma, ...rest] = input.split(',');
  const locality = rest.join(',').trim();
  const place = locality ? { locality } : null;
  const street = beforeComma.trim();
  // Trailing token starting with a digit is the plot/building number.
  const match = street.match(/^(.*?)[\s]+(\d[\w-]*)$/);
  if (match) {
    return { street: match[1].trim(), houseNumber: match[2], ...place };
  }
  return { street, ...place };
};

// The registry reads `contains: ''` — and a wildcard-only string, since `%` is
// one — as "match everything": all 60,279 streets, which outruns the name walk
// and drops the query onto a scan of every one of the 1.1M address rows. ", ab"
// and ",,," parse to exactly that, and the endpoint's own min:3 counts the comma.
const NAME_MIN_CHARS = 3;

export const isSearchableName = (name: string) =>
  name.replace(/[%_\s]/g, '').length >= NAME_MIN_CHARS;

// The registry holds place names in the genitive ("Vilniaus m. sav."), people
// type the nominative ("Vilnius"), and `contains` is a plain substring match —
// so the ending has to go before the two can meet.
export const localityStem = (locality: string): string => {
  const cleaned = locality.trim().replace(/\s+(m|r|mstl|k|sav|apskr)\.?$/i, '');
  const stem = cleaned.replace(/s$/i, '').replace(/[aąeęėiįyouų]+$/i, '');
  return stem.length >= 3 ? stem : cleaned;
};

// A place without the word for its kind: "Vilniaus m. sav." and "Vilniaus m."
// both stem to "Vilniaus".
const placeStem = (name: string) => name.replace(/(\s+(m|r|mstl|k|sen|sav)\.?)+$/i, '').trim();

// Build a human-readable label: "<street full name> <building no>, <settlement>,
// <municipality>". Falls back to residential area when there's no street (rural
// addresses). One municipality holds the same street name in several villages,
// and without the settlement those rows read as one row repeated — except in a
// city, where the settlement only says the municipality over again.
export const buildLabel = (a: Address): string => {
  const area = a.residential_area?.name?.trim() || '';
  const streetPart = a.street?.full_name || a.street?.name || area;
  const number = a.plot_or_building_number ? ` ${a.plot_or_building_number}` : '';
  const muniName = a.municipality?.name?.trim() || '';
  const settlement =
    area && area !== streetPart && placeStem(area) !== placeStem(muniName) ? `, ${area}` : '';
  const muni = muniName ? `, ${muniName}` : '';

  return `${streetPart}${number}${settlement}${muni}`.trim().replace(/^,\s*/, '');
};

// The house number narrows the street branch only — the residential-area branch
// exists for rural input that names no street, where the number rarely helps.
const houseNumberFilter = (houseNumber?: string) =>
  houseNumber ? { addresses: { plot_or_building_number: { starts: houseNumber } } } : null;

// OR-combined address filters built from already-resolved street / residential-area
// codes. Returns an empty array when neither name matched anything — the caller
// MUST NOT search then: the registry reads `filters: []` as "no filter" and
// answers with the first page of all 1.1M addresses.
export const buildAddressFilters = (params: {
  streetCodes: number[];
  areaCodes: number[];
  houseNumber?: string;
  municipalityCodes?: number[];
}): AddressesSearchFilterRequest[] => {
  const { streetCodes, areaCodes, houseNumber, municipalityCodes } = params;
  // Filtering addresses by a joined NAME is the scan this whole path avoids, so
  // the named place is narrowed by code like the street is.
  const place = municipalityCodes?.length ? { municipalities: { codes: municipalityCodes } } : null;
  const filters: AddressesSearchFilterRequest[] = [];

  if (streetCodes.length) {
    filters.push({
      streets: { codes: streetCodes },
      ...houseNumberFilter(houseNumber),
      ...place,
    });
  }

  if (areaCodes.length) {
    filters.push({ residential_areas: { codes: areaCodes }, ...place });
  }

  return filters;
};

// The filter shape the code lookup replaces: correct, but it makes the registry
// scan every address row because the joined street / area name is not indexed.
// Kept for names that match more streets than MAX_NAME_MATCHES.
export const buildNameFilters = (
  street: string,
  houseNumber?: string,
  municipalityCodes?: number[],
): AddressesSearchFilterRequest[] => {
  const place = municipalityCodes?.length ? { municipalities: { codes: municipalityCodes } } : null;

  return [
    { streets: { name: { contains: street } }, ...houseNumberFilter(houseNumber), ...place },
    { residential_areas: { name: { contains: street } }, ...place },
  ];
};

// The registry names a place by its kind: "Vilniaus m." is a city, "Kamajų mstl."
// a town, "Škėvonių k." a village. Someone typing a street name alone is far
// likelier to mean the city one.
const PLACE_RANK = [/\sm\.$/, /\smstl\.$/, /\ssen\.$/, /\sk\.$/];
const CITY_MUNICIPALITY = /\sm\.\s*sav/i;

// Order a name's codes so the places worth asking about come first: the seven
// cities, then the remaining towns, then the villages.
export const orderByPlaceKind = (rows: CodeRow[], cityPlaces: string[] = []): number[] => {
  const rank = (row: CodeRow) => {
    const place = row.residential_area?.name || row.name || '';
    if (cityPlaces.includes(place)) return 0;
    const kind = PLACE_RANK.findIndex((test) => test.test(place));
    return kind === -1 ? PLACE_RANK.length + 1 : kind + 1;
  };

  return [...rows].sort((a, b) => rank(a) - rank(b)).map((row) => row.code);
};

// Order the rows we got back. When a place was named, `municipalityCodes` already
// carries the order it should be read in (city before the district around it);
// with no place named, the seven city municipalities lead. Within one
// municipality the kind of settlement decides.
export const rankByPlace = (items: Address[], municipalityCodes: number[] = []): Address[] => {
  const municipalityRank = (a: Address) => {
    if (!municipalityCodes.length)
      return CITY_MUNICIPALITY.test(a.municipality?.name || '') ? 0 : 1;
    const index = municipalityCodes.indexOf(a.municipality?.code);
    return index === -1 ? municipalityCodes.length : index;
  };

  const placeRank = (a: Address) => {
    const index = PLACE_RANK.findIndex((test) => test.test(a.residential_area?.name || ''));
    return index === -1 ? PLACE_RANK.length : index;
  };

  return [...items].sort(
    (a, b) => municipalityRank(a) - municipalityRank(b) || placeRank(a) - placeRank(b),
  );
};

// With no place named, eight house numbers from one city answer a question
// nobody asked — the reader is still choosing WHERE. One row per place comes
// first, so the list shows where the name exists at all; the rest fill in behind.
export const spreadByPlace = (items: Address[]): Address[] => {
  const first: Address[] = [];
  const rest: Address[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const place = item.residential_area?.name || item.municipality?.name || '';
    if (seen.has(place)) rest.push(item);
    else {
      seen.add(place);
      first.push(item);
    }
  }

  return [...first, ...rest];
};

export const toSuggestions = (items: Address[]): AddressSuggestion[] =>
  items
    .filter((a) => a?.geometry?.data)
    .map((a) => ({
      code: a.code,
      label: buildLabel(a),
      geometry: wktToGeoJSON(a.geometry.data) as any,
    }))
    .filter((s) => !!s.label);

interface CodeRow {
  code: number;
  name?: string | null;
  residential_area?: { name?: string | null } | null;
}

interface CodePage {
  items: CodeRow[];
  total?: number | null;
  next_page?: string | null;
}

export interface CodeSet {
  codes: number[];
  // False when the name matches more rows than we walk. A truncated list must
  // never reach the address query: it would silently drop addresses the name
  // filter used to return.
  complete: boolean;
}

// Shared by the street and residential-area walks: the address query needs both
// code sets, so once one gives up the other's remaining pages are wasted work.
export interface WalkGuard {
  givenUp: boolean;
}

// Resolving a name to codes is ~65% of a suggestion's wall clock (0.33-0.83s out
// of 0.55-1.20s, measured against the registry), and it asks a question whose
// answer never moves: street and area names are static. It is also asked over
// and over, because the street part is what survives every keystroke of a house
// number - "Gedimino pr.", "Gedimino pr. 9" and "Gedimino pr. 91" all resolve
// the same two names. So memoise on the name, where the whole-query cache in the
// service cannot help.
const CODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_CACHE_MAX_ENTRIES = 2000;
const codeCache = new Map<string, { value: CodeSet; expiry: number }>();

export const clearCodeCache = () => {
  codeCache.clear();
  cityPlacesCache = undefined;
};

export const resolveCodes = async (
  key: string,
  resolve: () => Promise<CodeSet>,
): Promise<CodeSet> => {
  const hit = codeCache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.value;

  const value = await resolve();
  // An incomplete set is never cached. Giving up means either "the name matches
  // more streets than we walk" or "the registry answered 500", and the two look
  // identical here - caching the blip would pin the slow path for a day.
  if (!value.complete) return value;

  if (codeCache.size >= CODE_CACHE_MAX_ENTRIES) {
    codeCache.delete(codeCache.keys().next().value);
  }
  codeCache.set(key, { value, expiry: Date.now() + CODE_CACHE_TTL_MS });
  return value;
};

// Walk a cursor-paginated name search and collect every matching code.
export const collectCodes = async (
  fetchPage: (cursor?: string) => Promise<CodePage>,
  guard: WalkGuard = { givenUp: false },
  cityPlaces: string[] = [],
): Promise<CodeSet> => {
  const rows: CodeRow[] = [];
  let cursor: string | undefined;

  const giveUp = (): CodeSet => {
    guard.givenUp = true;
    return { codes: [], complete: false };
  };

  // `total` comes back with the first page, so an oversized name costs one
  // request to reject rather than a full walk.
  for (let page = 0; page * PAGE_SIZE <= MAX_NAME_MATCHES; page++) {
    if (guard.givenUp) return { codes: [], complete: false };

    let result: CodePage;
    try {
      result = await fetchPage(cursor);
    } catch {
      // The registry answers 500 on some deep cursors. Give up rather than
      // return what we have: a partial code set would silently drop addresses.
      return giveUp();
    }
    if ((result.total ?? 0) > MAX_NAME_MATCHES) return giveUp();

    const items = result.items || [];
    rows.push(...items);
    if (items.length < PAGE_SIZE || !result.next_page) {
      return { codes: orderByPlaceKind(rows, cityPlaces), complete: true };
    }

    // The registry hands back a percent-encoded cursor and the generated client
    // encodes query values again. Passing it through as-is sends %253D, which the
    // registry reads as "start from the top" — the same page, forever.
    cursor = decodeURIComponent(result.next_page);
  }

  return giveUp();
};

// The registry names seven municipalities after a city ("Vilniaus m. sav.") and
// the settlement inside one the same way without the "sav." ("Vilniaus m."), so
// it can say which places are cities itself — over a table of sixty static rows.
const fetchCityPlaces = async (): Promise<string[]> => {
  const found = await municipalitiesSearch({
    requestBody: { filters: [{ municipalities: { name: { contains: 'm. sav.' } } }] },
    size: PAGE_SIZE,
  });

  return (found.items || [])
    .map((m) => (m.name || '').replace(/\s*sav\.?$/i, '').trim())
    .filter((name) => !!name);
};

let cityPlacesCache: Promise<string[]> | undefined;

export const resolveCityPlaces = (): Promise<string[]> =>
  (cityPlacesCache ??= fetchCityPlaces().catch(() => {
    // Ranking is a nicety; a registry blip must not cost the whole suggestion.
    cityPlacesCache = undefined;
    return [];
  }));

// "Vilnius" names two municipalities to the registry — the city and the district
// around it. Someone who typed no kind means the city, so it leads.
export const orderMunicipalities = (
  names: Array<{ code: number; name?: string | null }>,
  locality: string,
): number[] => {
  const typedKind = /\b(r|m)\.?\s*(sav\.?)?$/i.exec(locality.trim())?.[1]?.toLowerCase();
  const kindOf = (name?: string | null) => (/\sm\.\s*sav/i.test(name || '') ? 'm' : 'r');
  const wanted = typedKind === 'r' ? 'r' : 'm';

  return [...names]
    .sort((a, b) => Number(kindOf(b.name) === wanted) - Number(kindOf(a.name) === wanted))
    .map((m) => m.code);
};

// Resolving the named place costs one small request against a table of sixty
// rows, and the answer never changes, so it is kept like the street codes are.
export const resolveMunicipalityCodes = async (locality: string): Promise<number[]> => {
  const stem = localityStem(locality);
  if (stem.length < 3) return [];

  const { codes } = await resolveCodes(`municipality:${stem.toLowerCase()}`, async () => {
    const found = await municipalitiesSearch({
      requestBody: { filters: [{ municipalities: { name: { contains: stem } } }] },
      size: PAGE_SIZE,
    });
    return { codes: orderMunicipalities(found.items || [], locality), complete: true };
  });

  return codes;
};

// The registry answers 500 to an address query for most villages — 19 of a
// 30-village sample, each after some four seconds — so a rural address often
// cannot be reached at all. The settlement itself it serves in 0.3s, and it is
// the place the reader was pointing at, so it is offered rather than nothing.
const SETTLEMENT_LIMIT = 3;

// The registry answers 500 and 502 to these lookups often enough that one
// retry is the difference between a village showing up and a reader being told
// their address does not exist.
const retried = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch {
    return run();
  }
};

// Every suggestion is a point, whatever it names: the reader's map centres on
// it and a subscription is drawn around it. A settlement is served as its
// border, so the middle of that border is what is handed over.
const positions = (coordinates: any): number[][] =>
  typeof coordinates?.[0] === 'number' ? [coordinates] : (coordinates || []).flatMap(positions);

export const centrePoint = (geometry: any) => {
  if (!geometry?.coordinates) return undefined;
  if (geometry.type === 'Point') return geometry;

  const points = positions(geometry.coordinates);
  if (!points.length) return undefined;

  // Reduced rather than spread into Math.min: a settlement border runs to
  // thousands of points, and the spread would outgrow the argument limit.
  const bounds = points.reduce(
    (acc, [x, y]) => ({
      minX: Math.min(acc.minX, x),
      maxX: Math.max(acc.maxX, x),
      minY: Math.min(acc.minY, y),
      maxY: Math.max(acc.maxY, y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  return {
    type: 'Point',
    coordinates: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
  };
};

export const settlementLabel = (area: {
  name?: string | null;
  municipality?: { name?: string | null } | null;
}): string => [area.name, area.municipality?.name].filter(Boolean).join(', ');

export const settlementSuggestions = async (
  areaCodes: number[],
  municipalityCodes: number[],
): Promise<AddressSuggestion[]> => {
  if (!areaCodes.length) return [];

  const found = await retried(() =>
    residentialAreasSearch({
      requestBody: { filters: [{ residential_areas: { codes: areaCodes.slice(0, PAGE_SIZE) } }] },
      size: PAGE_SIZE,
    }),
  );

  const rows = (found.items || []).filter(
    (area) => !municipalityCodes.length || municipalityCodes.includes(area.municipality?.code),
  );
  // A settlement carries its geometry on its own endpoint, one request each, so
  // the list is cut to what a reader reads before any of them are fetched.
  const codes = orderByPlaceKind(rows).slice(0, SETTLEMENT_LIMIT);
  const detailed = await Promise.all(
    codes.map((code) =>
      retried(() => residentialAreasGetWithGeometry({ code, srid: 4326 })).catch(() => undefined),
    ),
  );

  return detailed
    .filter((area) => !!area?.geometry?.data)
    .map((area) => ({
      code: area!.code,
      label: settlementLabel(area!),
      geometry: centrePoint(wktToGeoJSON(area!.geometry.data)),
    }))
    .filter((suggestion) => !!suggestion.label && !!suggestion.geometry);
};

// Two steps, because the registry indexes address rows by street / area code but
// not by the joined street or area NAME. Filtering 1.1M addresses by name is a
// full scan (~4-8s); resolving the name to codes first and filtering by those
// answers in well under a second with the same rows.
export const searchAddressSuggestions = async (search: string): Promise<AddressSuggestion[]> => {
  // Split the input into a street part, an optional house number and the place
  // it names: "Vilniaus g. 2, Vilnius" → "Vilniaus g.", "2", "Vilnius".
  const { street, houseNumber, locality } = parseAddressInput(search);
  if (!isSearchableName(street)) return [];

  const cityPlaces = await resolveCityPlaces();

  const guard: WalkGuard = { givenUp: false };
  const streetCodesOf = (name: string) =>
    resolveCodes(`street:${name.toLowerCase()}`, () =>
      collectCodes(
        (cursor) =>
          streetsSearch({
            requestBody: { filters: [{ streets: { name: { contains: name } } }] },
            size: PAGE_SIZE,
            cursor,
          }),
        guard,
        cityPlaces,
      ),
    );
  const areaCodesOf = (name: string) =>
    resolveCodes(`area:${name.toLowerCase()}`, () =>
      collectCodes(
        (cursor) =>
          residentialAreasSearch({
            requestBody: { filters: [{ residential_areas: { name: { contains: name } } }] },
            size: PAGE_SIZE,
            cursor,
          }),
        guard,
        cityPlaces,
      ),
    );

  // The lookups run together: they're independent, and the search needs both to
  // cover urban (street) and rural (residential area) input. The two name walks
  // share a guard, so when one gives up the other stops at its next page instead
  // of walking to the end for a result nothing will use.
  const [municipalityCodes, streets, areasByName] = await Promise.all([
    locality ? resolveMunicipalityCodes(locality) : Promise.resolve([]),
    streetCodesOf(street),
    areaCodesOf(street),
  ]);

  // Nothing carries that name — and a settlement is the one part people type in
  // the nominative ("Kaltinėnai") while the registry holds it in the genitive
  // ("Kaltinėnų mstl."), so the ending is what stood in the way.
  const stem = localityStem(street);
  const areas =
    !streets.codes.length && !areasByName.codes.length && stem !== street
      ? await areaCodesOf(stem)
      : areasByName;

  // A street name shared by hundreds of places answers with whichever rows the
  // registry reaches first, which is nobody's idea of the best eight. A wider
  // page is read so the ranking has something to choose from.
  const ask = async (filters: AddressesSearchFilterRequest[], sorted = true) => {
    // Nothing matched the name. Searching on an empty filter list would answer
    // with the first page of the whole registry.
    if (!filters.length) return [];

    // One request per branch rather than one OR'd query: the registry sorts a
    // union of two filters without an index, which costs it 4.4s where each
    // branch alone answers in under 0.3.
    const pages = await Promise.allSettled(
      filters.map((filter) =>
        addressesSearch({
          requestBody: { filters: [filter] },
          size: RANKING_PAGE_SIZE,
          srid: 4326,
          // Left to itself the registry answers in code order, which is roughly
          // the age of the row: one long street eats the whole page and the
          // newest street never appears (Vilnius' own Vilniaus g. holds the
          // highest code of the 228 that share the name). By house number the
          // streets interleave instead. Affordable over a code filter only —
          // over a name it triples a scan the registry then answers 500 to.
          ...(sorted
            ? { sortBy: 'plot_or_building_number' as const, sortOrder: 'asc' as const }
            : {}),
        }),
      ),
    );

    const failed = pages.filter((page) => page.status === 'rejected');
    const items = pages.flatMap((page) =>
      page.status === 'fulfilled' ? page.value.items || [] : [],
    );

    // A surviving branch's rows are worth showing. An empty list is not, while a
    // branch is failing: the caller caches "no such address" for a day, and the
    // reader is told their street does not exist.
    if (failed.length && !items.length) throw (failed[0] as PromiseRejectedResult).reason;
    const ranked = rankByPlace(items, municipalityCodes);
    const ordered = municipalityCodes.length ? ranked : spreadByPlace(ranked);

    return toSuggestions(ordered).slice(0, SUGGEST_LIMIT);
  };

  const addresses = async (): Promise<AddressSuggestion[]> => {
    // A fragment like "sod" matches thousands of streets. Fall back to the scan
    // so those inputs keep their exact results instead of a truncation.
    if (!streets.complete || !areas.complete) {
      return ask(buildNameFilters(street, houseNumber, municipalityCodes), false);
    }

    const allCodes = {
      streetCodes: streets.codes,
      areaCodes: areas.codes,
      houseNumber,
      municipalityCodes,
    };

    // The named place narrows the query on its own, so every street that matched
    // the name stays in play.
    if (municipalityCodes.length) return ask(buildAddressFilters(allCodes));

    // With no place named, "Vilniaus g." matches 228 streets and some 8000
    // addresses, and one page of those never reaches Vilnius. Ask the
    // best-ranked places first — the code lists are ordered, cities at the front.
    const preferred = await ask(
      buildAddressFilters({
        ...allCodes,
        streetCodes: streets.codes.slice(0, PREFERRED_CODES),
        areaCodes: areas.codes.slice(0, PREFERRED_CODES),
      }),
    );
    if (preferred.length >= SUGGEST_LIMIT) return preferred;

    // A name no city carries — or a house number only a village has — needs the
    // rest of the matches to fill the list out.
    const rest = await ask(buildAddressFilters(allCodes));
    const seen = new Set(preferred.map((s) => s.code));

    return [...preferred, ...rest.filter((s) => !seen.has(s.code))].slice(0, SUGGEST_LIMIT);
  };

  // The registry failing is not the same as there being nothing: the caller
  // caches an empty list for a day, so the error has to survive the fallback.
  let failure: unknown;
  const found = await addresses().catch((err) => {
    failure = err;
    return [] as AddressSuggestion[];
  });
  if (found.length) return found;

  const settlements = await settlementSuggestions(areas.codes, municipalityCodes).catch(() => []);
  if (settlements.length) return settlements;
  if (failure) throw failure;

  return [];
};
