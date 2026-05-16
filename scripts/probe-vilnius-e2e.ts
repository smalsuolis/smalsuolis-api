/* eslint-disable no-console */
// End-to-end exercise of the vilnius scraper: scrape N pages, extract every
// cadastral seen, resolve all of them via parcelsSearch (with the same
// zero-pad normalization the service applies), and report how many events
// would survive attachGeometries.
//
// Usage: yarn ts-node scripts/probe-vilnius-e2e.ts [pages]

import puppeteer, { Browser } from 'puppeteer';
import { parcelsSearch } from '../utils/boundaries';

const WS = process.env.CHROME_WS_ENDPOINT || 'ws://localhost:9321';
const LISTING_BASE = 'https://vilnius.lt/naujienos?categories=65';
const REAL_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CADASTRAL_PATTERN = /\d+\/\d+:\d+/g;

function normalizeCadastral(c: string): string {
  const m = c.match(/^(\d+)\/(\d+):(\d+)$/);
  if (!m) return c;
  return `${m[1]}/${m[2]}:${m[3].padStart(4, '0')}`;
}

interface Item {
  link: string;
  title: string;
  cadastrals: string[];
}

async function main() {
  const pagesToProbe = Number(process.argv[2]) || 4;
  const browser: Browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    acceptInsecureCerts: true,
  });

  const items: Item[] = [];
  try {
    for (let p = 1; p <= pagesToProbe; p++) {
      const page = await browser.newPage();
      await page.setUserAgent(REAL_UA);
      await page.setViewport({ width: 1920, height: 1080 });
      const url = `${LISTING_BASE}&page=${p}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const found = await page
        .waitForSelector('[data-test="news-card"]', { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!found) {
        console.log(`[probe] page ${p}: no cards, stopping`);
        await page.close();
        break;
      }
      const pageItems: Item[] = await page.evaluate((pattern: string) => {
        const re = new RegExp(pattern, 'g');
        const cards = Array.from(document.querySelectorAll('[data-test="news-card"]'));
        return cards.map((card) => {
          const a = card.querySelector('a[href^="/naujienos/"]');
          const link = a?.getAttribute('href') || '';
          const heading = card.querySelector('h2, h3, h4, [class*="title"], [class*="Title"]');
          const title = heading?.textContent?.trim() || '';
          return { link, title, cadastrals: (title.match(re) || []) as string[] };
        });
      }, CADASTRAL_PATTERN.source);
      items.push(...pageItems);
      console.log(`[probe] page ${p}: ${pageItems.length} cards`);
      await page.close();
    }
  } finally {
    await browser.disconnect().catch(() => null);
  }

  const itemsWithCad = items.filter((i) => i.cadastrals.length > 0);
  const allCadsRaw = itemsWithCad.flatMap((i) => i.cadastrals);
  const allCadsNorm = [...new Set(allCadsRaw.map(normalizeCadastral))];
  console.log(
    `\n[probe] items=${items.length} withCadastral=${itemsWithCad.length} ` +
      `uniqueCadastrals=${allCadsNorm.length}`,
  );

  // Resolve in chunks the same way the service does.
  const found = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < allCadsNorm.length; i += chunkSize) {
    const chunk = allCadsNorm.slice(i, i + chunkSize);
    const data = await parcelsSearch({
      requestBody: { filters: chunk.map((c) => ({ parcels: { cadastral_number: { exact: c } } })) },
      size: chunkSize,
      srid: 4326,
    });
    data.items?.forEach((it: any) => it?.cadastral_number && found.add(it.cadastral_number));
  }

  console.log(
    `[probe] resolved ${found.size}/${allCadsNorm.length} via parcelsSearch ` +
      `(missing=${allCadsNorm.length - found.size})`,
  );

  // Items that would actually become events.
  let surviving = 0;
  const dropped: Array<{ link: string; cadastrals: string[] }> = [];
  for (const item of itemsWithCad) {
    const anyResolved = item.cadastrals.some((c) => found.has(normalizeCadastral(c)));
    if (anyResolved) surviving++;
    else dropped.push({ link: item.link, cadastrals: item.cadastrals });
  }
  console.log(
    `[probe] surviving events: ${surviving}/${itemsWithCad.length} ` +
      `(dropped: ${dropped.length})`,
  );
  if (dropped.length) {
    console.log('\n[probe] dropped items (no geometry):');
    dropped.slice(0, 10).forEach((d) =>
      console.log(`  ${d.cadastrals.join(',')} ← ${d.link}`),
    );
  }
}

main().catch((err) => {
  console.error('[probe] failed:', err);
  process.exit(1);
});
