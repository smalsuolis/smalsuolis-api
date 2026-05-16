/* eslint-disable no-console */
// Probe variants of weird cadastrals against parcelsSearch to find
// what form the API actually stores.

import { parcelsSearch } from '../utils/boundaries';

function pad(c: string, last: number, mid?: number): string {
  const m = c.match(/^(\d+)\/(\d+):(\d+)$/);
  if (!m) return c;
  const [_, a, b, d] = m;
  return `${a}/${mid ? b.padStart(mid, '0') : b}:${d.padStart(last, '0')}`;
}

const targets = [
  '0101/0032:479', // last=3
  '0101/00730:167', // mid=5
  '0101/00159:74', // mid=5, last=2
  '0101/0075:1432', // 4/4 — should just work
];

(async () => {
  for (const cad of targets) {
    const variants = new Set<string>([
      cad,
      pad(cad, 4),
      pad(cad, 4, 4),
      pad(cad, 4, 5),
      pad(cad, 5),
      pad(cad, 3),
    ]);
    console.log(`\n--- ${cad} ---`);
    for (const v of variants) {
      try {
        const data = await parcelsSearch({
          requestBody: { filters: [{ parcels: { cadastral_number: { exact: v } } }] },
          size: 1,
          srid: 4326,
        });
        const hit = data.items?.[0]?.cadastral_number;
        console.log(`  query=${v.padEnd(20)} → ${hit ?? '(no match)'}`);
      } catch (err: any) {
        console.log(`  query=${v.padEnd(20)} → ERROR ${err?.message || err}`);
      }
    }

    // Try a contains-style filter — maybe the API supports it
    try {
      const m = cad.match(/^(\d+)\/(\d+):(\d+)$/);
      if (m) {
        const data: any = await parcelsSearch({
          requestBody: {
            filters: [{ parcels: { cadastral_number: { contains: cad } as any } }],
          } as any,
          size: 3,
          srid: 4326,
        });
        const hits = (data.items || []).map((it: any) => it?.cadastral_number);
        console.log(`  contains=${cad}  → ${JSON.stringify(hits)}`);
      }
    } catch (err: any) {
      console.log(`  contains=${cad} → ERROR ${err?.message || err}`);
    }
  }
})();
