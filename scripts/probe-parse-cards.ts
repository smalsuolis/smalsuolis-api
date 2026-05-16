/* eslint-disable no-console */
// Run the vilnius card parser against a saved HTML file (/tmp/vln.html) to
// confirm regex extraction matches what we observed via puppeteer.

import fs from 'node:fs';

const CADASTRAL_PATTERN = /\d+\/\d+:\d+/g;

interface VilniusItem {
  link: string;
  title: string;
  date: string | null;
  cadastrals: string[];
}

function parseCards(html: string): VilniusItem[] {
  const cardMarker = /data-test="news-card"/g;
  const chunks: string[] = [];
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = cardMarker.exec(html))) {
    if (lastIdx >= 0) chunks.push(html.slice(lastIdx, m.index));
    lastIdx = m.index;
  }
  if (lastIdx >= 0) chunks.push(html.slice(lastIdx, lastIdx + 4000));

  const items: VilniusItem[] = [];
  for (const chunk of chunks) {
    const linkMatch = chunk.match(/href="(\/naujienos\/[^"]+)"/);
    const link = linkMatch?.[1] || '';
    if (!link) continue;
    const headingMatch = chunk.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
    const title = (headingMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const dateMatch = chunk.match(/\d{4}-\d{2}-\d{2}/);
    const date = dateMatch?.[0] || null;
    const cadastrals = title.match(CADASTRAL_PATTERN) || [];
    items.push({ link, title, date, cadastrals });
  }
  return items;
}

const path = process.argv[2] || '/tmp/vln.html';
const html = fs.readFileSync(path, 'utf-8');
const items = parseCards(html);
console.log(`parsed ${items.length} cards from ${path}`);
items.forEach((it, i) => {
  console.log(`[${i}] cadastrals=${JSON.stringify(it.cadastrals)} date=${it.date}`);
  console.log(`     link=${it.link}`);
  console.log(`     title=${it.title.slice(0, 100)}`);
});
const withCad = items.filter((i) => i.cadastrals.length).length;
console.log(`\n${withCad}/${items.length} items have cadastrals in title`);
