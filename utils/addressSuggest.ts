import { wktToGeoJSON } from 'betterknown';
import {
  Address,
  AddressesSearchFilterRequest,
  addressesSearch,
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

// Split free-text input into the parts the registry can filter on.
// "Vilniaus g. 2, Vilnius" → { street: 'Vilniaus g.', houseNumber: '2' }
// "Gedimino"              → { street: 'Gedimino',   houseNumber: undefined }
// Everything after the first comma is a locality hint we don't filter on — the
// registry has no combined free-text search, and including it would match no
// street name.
export const parseAddressInput = (input: string): { street: string; houseNumber?: string } => {
  const beforeComma = input.split(',')[0].trim();
  // Trailing token starting with a digit is the plot/building number.
  const match = beforeComma.match(/^(.*?)[\s]+(\d[\w-]*)$/);
  if (match) {
    return { street: match[1].trim(), houseNumber: match[2] };
  }
  return { street: beforeComma };
};

// Build a human-readable label: "<street full name> <building no>, <municipality>".
// Falls back to residential area when there's no street (rural addresses).
export const buildLabel = (a: Address): string => {
  const streetPart = a.street?.full_name || a.street?.name || a.residential_area?.name || '';
  const number = a.plot_or_building_number ? ` ${a.plot_or_building_number}` : '';
  const muni = a.municipality?.name ? `, ${a.municipality.name}` : '';
  return `${streetPart}${number}${muni}`.trim().replace(/^,\s*/, '');
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
}): AddressesSearchFilterRequest[] => {
  const { streetCodes, areaCodes, houseNumber } = params;
  const filters: AddressesSearchFilterRequest[] = [];
  if (streetCodes.length) {
    filters.push({ streets: { codes: streetCodes }, ...houseNumberFilter(houseNumber) });
  }
  if (areaCodes.length) {
    filters.push({ residential_areas: { codes: areaCodes } });
  }
  return filters;
};

// The filter shape the code lookup replaces: correct, but it makes the registry
// scan every address row because the joined street / area name is not indexed.
// Kept for names that match more streets than MAX_NAME_MATCHES.
export const buildNameFilters = (
  street: string,
  houseNumber?: string,
): AddressesSearchFilterRequest[] => [
  { streets: { name: { contains: street } }, ...houseNumberFilter(houseNumber) },
  { residential_areas: { name: { contains: street } } },
];

export const toSuggestions = (items: Address[]): AddressSuggestion[] =>
  items
    .filter((a) => a?.geometry?.data)
    .map((a) => ({
      code: a.code,
      label: buildLabel(a),
      geometry: wktToGeoJSON(a.geometry.data) as any,
    }))
    .filter((s) => !!s.label);

interface CodePage {
  items: Array<{ code: number }>;
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

// Walk a cursor-paginated name search and collect every matching code.
export const collectCodes = async (
  fetchPage: (cursor?: string) => Promise<CodePage>,
  guard: WalkGuard = { givenUp: false },
): Promise<CodeSet> => {
  const codes: number[] = [];
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
    codes.push(...items.map((item) => item.code));
    if (items.length < PAGE_SIZE || !result.next_page) return { codes, complete: true };

    // The registry hands back a percent-encoded cursor and the generated client
    // encodes query values again. Passing it through as-is sends %253D, which the
    // registry reads as "start from the top" — the same page, forever.
    cursor = decodeURIComponent(result.next_page);
  }

  return giveUp();
};

// Two steps, because the registry indexes address rows by street / area code but
// not by the joined street or area NAME. Filtering 1.1M addresses by name is a
// full scan (~4-8s); resolving the name to codes first and filtering by those
// answers in well under a second with the same rows.
export const searchAddressSuggestions = async (search: string): Promise<AddressSuggestion[]> => {
  // Split the input into a street part and an optional house number, e.g.
  // "Vilniaus g. 2, Vilnius" → street "Vilniaus g.", number "2".
  const { street, houseNumber } = parseAddressInput(search);

  // Both name lookups run together: they're independent, and the OR below needs
  // both to cover urban (street) and rural (residential area) input. They share
  // a guard so that when one gives up the other stops at its next page instead
  // of walking to the end for a result nothing will use.
  const guard: WalkGuard = { givenUp: false };
  const [streets, areas] = await Promise.all([
    collectCodes(
      (cursor) =>
        streetsSearch({
          requestBody: { filters: [{ streets: { name: { contains: street } } }] },
          size: PAGE_SIZE,
          cursor,
        }),
      guard,
    ),
    collectCodes(
      (cursor) =>
        residentialAreasSearch({
          requestBody: { filters: [{ residential_areas: { name: { contains: street } } }] },
          size: PAGE_SIZE,
          cursor,
        }),
      guard,
    ),
  ]);

  const filters =
    streets.complete && areas.complete
      ? buildAddressFilters({
          streetCodes: streets.codes,
          areaCodes: areas.codes,
          houseNumber,
        })
      : // A fragment like "sod" matches thousands of streets. Fall back to the
        // scan so those inputs keep their exact results instead of a truncation.
        buildNameFilters(street, houseNumber);

  // Nothing matched the name. Searching on an empty filter list would answer
  // with the first page of the whole registry.
  if (!filters.length) return [];

  const addresses = await addressesSearch({
    requestBody: { filters },
    size: SUGGEST_LIMIT,
    srid: 4326,
  });

  return toSuggestions(addresses.items || []);
};
