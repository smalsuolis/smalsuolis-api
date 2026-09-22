/**
 * Proves the two-step address suggest returns the SAME suggestions as the
 * name-filter query it replaces, and measures both.
 *
 * The old query filtered 1.1M address rows by the joined street / residential
 * area NAME, which the registry cannot index (~4s per keystroke). The new one
 * resolves the name to street / area codes first and filters by those. This
 * probe runs both against the live registry and diffs the results.
 *
 *   npx ts-node scripts/probe-address-suggest-parity.ts
 */
import { addressesSearch } from '../utils/boundaries';
import {
  AddressSuggestion,
  parseAddressInput,
  searchAddressSuggestions,
  toSuggestions,
} from '../utils/addressSuggest';

// The query shape this branch replaces, kept verbatim so the diff is honest.
const legacySuggest = async (search: string): Promise<AddressSuggestion[]> => {
  const { street, houseNumber } = parseAddressInput(search);
  const data = await addressesSearch({
    requestBody: {
      filters: [
        {
          streets: { name: { contains: street } },
          ...(houseNumber
            ? { addresses: { plot_or_building_number: { starts: houseNumber } } }
            : null),
        },
        { residential_areas: { name: { contains: street } } },
      ],
    },
    size: 8,
    srid: 4326,
  });
  return toSuggestions(data.items || []);
};

const QUERIES = [
  // Urban streets, from very common to rare.
  'Gedimino',
  'Vilniaus g.',
  'Laisvės al.',
  'Didžioji g.',
  'Ąžuolų g.',
  'Šilutės pl.',
  'J. Basanavičiaus g.',
  // Street plus house number, including a letter suffix.
  'Vilniaus g. 2',
  'Gedimino pr. 9',
  'Taikos pr. 10',
  'Sodo g. 1',
  'Vilniaus g. 22A',
  // Locality hint after the comma (dropped by both paths).
  'Vilniaus g. 2, Kaunas',
  // Rural input naming a residential area rather than a street.
  'Kaltinėnų mstl.',
  'Kaltinėnai',
  'Palanga',
  // A street name that merely contains digits.
  'Kalno 3-oji g.',
  // Nothing matches.
  'zzzqqq',
  // Fragments a user passes through while typing. The three-letter ones match
  // more streets than the code walk will collect, so they take the fallback.
  'Ged',
  'Viln',
  'Ąžuolų',
  'Lai',
  'Sod',
  'Kal',
  'Vil',
];

// The legacy scan is slow enough that the registry's CDN sometimes answers 504
// before the origin finishes, so a failure is a result worth reporting too.
const time = async (
  fn: () => Promise<AddressSuggestion[]>,
): Promise<[AddressSuggestion[] | null, number]> => {
  const started = Date.now();
  try {
    return [await fn(), Date.now() - started];
  } catch (err) {
    console.log(`    error: ${(err as Error).message}`);
    return [null, Date.now() - started];
  }
};

const key = (s: AddressSuggestion) => `${s.code}|${s.label}|${JSON.stringify(s.geometry)}`;

const main = async () => {
  let mismatches = 0;
  let failures = 0;
  let legacyTotal = 0;
  let currentTotal = 0;

  for (const query of QUERIES) {
    const [legacy, legacyMs] = await time(() => legacySuggest(query));
    const [current, currentMs] = await time(() => searchAddressSuggestions(query));
    legacyTotal += legacyMs;
    currentTotal += currentMs;

    if (!legacy || !current) {
      failures++;
      console.log(
        `${(legacy ? 'CURRENT FAILED' : 'LEGACY FAILED').padEnd(25)} ` +
          `${String(legacyMs).padStart(5)}ms -> ${String(currentMs).padStart(5)}ms  "${query}"`,
      );
      continue;
    }

    const legacyKeys = legacy.map(key);
    const currentKeys = current.map(key);
    const sameOrder = JSON.stringify(legacyKeys) === JSON.stringify(currentKeys);
    const sameSet =
      legacyKeys.length === currentKeys.length &&
      [...legacyKeys].sort().join() === [...currentKeys].sort().join();

    const verdict = sameOrder ? 'IDENTICAL' : sameSet ? 'SAME ROWS, ORDER DIFFERS' : 'MISMATCH';
    if (!sameOrder) mismatches++;

    console.log(
      `${verdict.padEnd(25)} ${String(legacyMs).padStart(5)}ms -> ${String(currentMs).padStart(
        5,
      )}ms  n=${legacy.length}  "${query}"`,
    );

    if (!sameSet) {
      const missing = legacyKeys.filter((k) => !currentKeys.includes(k));
      const extra = currentKeys.filter((k) => !legacyKeys.includes(k));
      missing.forEach((k) => console.log(`    lost:  ${k}`));
      extra.forEach((k) => console.log(`    added: ${k}`));
    }
  }

  console.log(
    `\n${QUERIES.length} queries, ${mismatches} mismatched, ${failures} unusable. ` +
      `Total ${legacyTotal}ms -> ${currentTotal}ms ` +
      `(avg ${Math.round(legacyTotal / QUERIES.length)}ms -> ${Math.round(
        currentTotal / QUERIES.length,
      )}ms).`,
  );
  process.exit(mismatches === 0 ? 0 : 1);
};

main();
