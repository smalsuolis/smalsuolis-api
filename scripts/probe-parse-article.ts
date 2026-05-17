/* eslint-disable no-console */
import fs from 'node:fs';

function parseArticle(html: string) {
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]{40,}?)<\/p>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim(),
  );

  const find = (keyword: string) =>
    paras.find((p) => p.toLowerCase().includes(keyword.toLowerCase())) ?? null;

  const currentRaw = find('Esama pagrindinė žemės naudojimo paskirtis');
  const requestedRaw = find('Pageidaujama pagrindinė žemės naudojimo paskirtis');
  const periodRaw = find('Prašymas viešinamas');

  const stripLabel = (s: string | null, label: string) =>
    s ? s.replace(new RegExp(`.*${label}[^:]*:\\s*`, 'i'), '').trim() : null;

  const currentUse = stripLabel(currentRaw, 'Esama pagrindinė žemės naudojimo paskirtis.*?būdas');
  const requestedUse = stripLabel(
    requestedRaw,
    'Pageidaujama pagrindinė žemės naudojimo paskirtis.*?būdas',
  );

  let commentPeriod: string | null = null;
  let commentEndDate: string | null = null;
  if (periodRaw) {
    const isoLike = [...periodRaw.matchAll(/(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/g)].map(
      (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
    );
    if (isoLike.length >= 2) {
      commentPeriod = `${isoLike[0]} – ${isoLike[1]}`;
      commentEndDate = isoLike[1];
    } else {
      const nuo = periodRaw.match(/nuo\s+([\d\s\w.]+?)(?:\s+iki|$)/i)?.[1]?.trim() ?? null;
      const iki = periodRaw.match(/iki\s+([\d\s\w.]+?)(?:\.|$)/i)?.[1]?.trim() ?? null;
      if (nuo && iki) commentPeriod = `${nuo} – ${iki}`;
      const ltMonths: Record<string, string> = {
        sausio: '01',
        vasario: '02',
        kovo: '03',
        balandžio: '04',
        gegužės: '05',
        birželio: '06',
        liepos: '07',
        rugpjūčio: '08',
        rugsėjo: '09',
        spalio: '10',
        lapkričio: '11',
        gruodžio: '12',
      };
      if (iki) {
        const ikiM = iki.match(/(\d{4})\s+m\.\s+(\w+)\s+(\d{1,2})\s+d/i);
        if (ikiM) {
          const mo = ltMonths[ikiM[2].toLowerCase()];
          if (mo) commentEndDate = `${ikiM[1]}-${mo}-${ikiM[3].padStart(2, '0')}`;
        }
      }
    }
  }

  return { currentUse, requestedUse, commentPeriod, commentEndDate };
}

const html = fs.readFileSync(process.argv[2] || '/tmp/vln-article.html', 'utf-8');
const result = parseArticle(html);
console.log(JSON.stringify(result, null, 2));
