/**
 * Runs the suggestion search against the live registry over the inputs the
 * autocomplete actually gets, and prints what a reader would see plus the places
 * the eight rows cover.
 *
 *   npx ts-node scripts/probe-address-suggest-locality.ts
 */
import { searchAddressSuggestions } from '../utils/addressSuggest';

const QUERIES = [
  // The two the bug report named: both streets exist in the city, and neither
  // used to be reachable through the suggestions.
  'Vilniaus g.',
  'Vilniaus g., Vilnius',
  'Vilniaus g. 2, Vilnius',
  'Lauko g.',
  'Lauko g., Jurbarkas',
  'Lauko g. 6, Jurbarkas',
  // Places named in the genitive the registry holds, and the nominative people type.
  'Kaltinėnų mstl.',
  'Kaltinėnai',
  'Palanga',
  // Urban streets, common to rare, with and without a house number.
  'Gedimino pr. 9, Vilnius',
  'Taikos pr., Klaipėda',
  'Laisvės al.',
  'J. Basanavičiaus g.',
  'Vilniaus g. 22A',
  'Kalno 3-oji g.',
  // Fragments passed through while typing: these outrun the code walk and take
  // the name-filter fallback.
  'Ged',
  'sod',
  'zzzqqq',
];

const main = async () => {
  let total = 0;

  for (const query of QUERIES) {
    const started = Date.now();
    const suggestions = await searchAddressSuggestions(query);
    const ms = Date.now() - started;
    total += ms;

    const places = new Set(suggestions.map((s) => s.label.split(', ').slice(1).join(', ')));
    console.log(`\n"${query}" — ${suggestions.length} in ${ms}ms, ${places.size} place(s)`);
    for (const s of suggestions.slice(0, 4)) console.log(`   ${s.label}`);
  }

  console.log(`\navg ${Math.round(total / QUERIES.length)}ms over ${QUERIES.length} queries`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
