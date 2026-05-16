/* eslint-disable no-console */
// Local probe for the vilnius.lt scraper. Connects to the browserless/chrome
// container from docker-compose, then walks a couple of listing pages and
// dumps what we can see so we can iterate selectors without round-tripping
// through dev.
//
// Usage: yarn ts-node scripts/probe-vilnius.ts [pages]

import puppeteer, { Browser } from 'puppeteer';
import { parcelsSearch } from '../utils/boundaries';

const WS = process.env.CHROME_WS_ENDPOINT || 'ws://localhost:9321';
const LISTING_BASE = 'https://vilnius.lt/naujienos?categories=65';
const REAL_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CADASTRAL_PATTERN = /\d+\/\d+:\d+/g;

async function main() {
  const pagesToProbe = Number(process.argv[2]) || 2;

  console.log(`[probe] connecting to ${WS}`);
  const browser: Browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    acceptInsecureCerts: true,
  });

  const seen = new Set<string>();
  try {
    for (let p = 1; p <= pagesToProbe; p++) {
      const page = await browser.newPage();
      await page.setUserAgent(REAL_UA);
      await page.setViewport({ width: 1920, height: 1080 });
      const url = `${LISTING_BASE}&page=${p}`;
      console.log(`\n[probe] === page ${p}: ${url} ===`);

      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`[probe] HTTP ${resp?.status()} final=${page.url()}`);

      // Wait for cards; if selector misses, dump body excerpt so we can see
      // what we *did* get (blocker page, captcha, empty list, etc.).
      const found = await page
        .waitForSelector('[data-test="news-card"]', { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (!found) {
        const bodyExcerpt = await page.evaluate(() => document.body.innerText.slice(0, 1500));
        const htmlExcerpt = await page.content();
        console.log('[probe] NO CARDS. body.innerText:\n', bodyExcerpt);
        console.log('[probe] HTML head 600 chars:\n', htmlExcerpt.slice(0, 600));
        await page.close();
        break;
      }

      const result = await page.evaluate((pattern: string) => {
        const re = new RegExp(pattern, 'g');
        const cards = Array.from(document.querySelectorAll('[data-test="news-card"]'));
        return cards.map((card) => {
          const a = card.querySelector('a[href^="/naujienos/"]');
          const link = a?.getAttribute('href') || '';
          const heading = card.querySelector('h2, h3, h4, [class*="title"], [class*="Title"]');
          const headingText = heading?.textContent?.trim() || '';
          const innerText = (card as HTMLElement).innerText || '';
          const dateMatch = innerText.match(/\d{4}-\d{2}-\d{2}/);
          const cadastralsInHeading = headingText.match(re) || [];
          const cadastralsInText = innerText.match(re) || [];
          return {
            link,
            headingText,
            innerTextLen: innerText.length,
            innerTextHead: innerText.replace(/\s+/g, ' ').slice(0, 200),
            date: dateMatch ? dateMatch[0] : null,
            cadastralsInHeading,
            cadastralsInText,
          };
        });
      }, CADASTRAL_PATTERN.source);

      console.log(`[probe] cards on page=${result.length}`);
      const newCards = result.filter((r) => r.link && !seen.has(r.link));
      newCards.forEach((r) => seen.add(r.link));
      console.log(`[probe] new (not seen on earlier pages)=${newCards.length}`);

      const sample = result.slice(0, 3);
      sample.forEach((r, i) => {
        console.log(`\n[probe] sample[${i}]`);
        console.log(`  link:    ${r.link}`);
        console.log(`  heading: ${JSON.stringify(r.headingText)}`);
        console.log(`  date:    ${r.date}`);
        console.log(`  cad-h:   ${JSON.stringify(r.cadastralsInHeading)}`);
        console.log(`  cad-t:   ${JSON.stringify(r.cadastralsInText)}`);
        console.log(`  text:    ${r.innerTextHead}`);
      });

      const withCadHeading = result.filter((r) => r.cadastralsInHeading.length).length;
      const withCadText = result.filter((r) => r.cadastralsInText.length).length;
      console.log(
        `[probe] cards with cadastral in heading=${withCadHeading} in text=${withCadText} of ${result.length}`,
      );

      await page.close();
    }
  } finally {
    await browser.disconnect().catch(() => null);
  }
  console.log(`\n[probe] done. unique links across all probed pages: ${seen.size}`);

  // Pick a few cadastrals we just saw and confirm parcelsSearch resolves them.
  // Without this, geometry-less events get silently dropped in attachGeometries.
  const sample = process.env.SKIP_PARCELS
    ? []
    : ['0101/0039:1330', '0101/0060:146', '0101/0039:1339', '0101/0052:0165', '7937/0002:279'];
  if (sample.length) {
    console.log(`\n[probe] resolving ${sample.length} cadastrals via parcelsSearch...`);
    try {
      const data = await parcelsSearch({
        requestBody: { filters: sample.map((c) => ({ parcels: { cadastral_number: { exact: c } } })) },
        size: sample.length,
        srid: 4326,
      });
      const got = (data.items || []).map((i: any) => i?.cadastral_number);
      console.log(`[probe] parcelsSearch returned ${got.length}/${sample.length}: ${JSON.stringify(got)}`);
      const missing = sample.filter((c) => !got.includes(c));
      if (missing.length) console.log(`[probe] missing: ${JSON.stringify(missing)}`);
    } catch (err: any) {
      console.error('[probe] parcelsSearch failed:', err?.message || err);
    }
  }
}

main().catch((err) => {
  console.error('[probe] failed:', err);
  process.exit(1);
});
