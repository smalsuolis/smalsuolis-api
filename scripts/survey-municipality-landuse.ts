/* eslint-disable no-console */
/**
 * Survey every municipality site for land-use-change publication notices.
 *
 * The Vilnius integration exists because vilnius.lt publishes each request as an
 * article with the cadastral number in it. Before writing 59 more scrapers we
 * need to know which municipalities publish this at all, and in what shape —
 * this script answers that, it does not scrape anything.
 *
 *   npx ts-node scripts/survey-municipality-landuse.ts            # every municipality
 *   npx ts-node scripts/survey-municipality-landuse.ts vilnius kaunas
 *
 * Writes scripts/out/municipality-landuse-survey.json alongside the summary.
 */
import fs from 'node:fs';
import path from 'node:path';

const BOUNDARIES = 'https://boundaries.biip.lt/v1/municipalities/search?size=100';

// What a publication notice is called. Municipalities word it differently, so
// a hit on any of these is worth a human look.
const TERMS = [
  // The wording vilnius.lt actually uses inside a notice — taken from the
  // article parser the Vilnius integration already relies on, not guessed.
  'esama pagrindinė žemės naudojimo paskirtis',
  'pageidaujama pagrindinė žemės naudojimo paskirtis',
  'prašymas viešinamas',
  'informacija apie žemės sklypo',
  // Broader phrasings other municipalities may use instead.
  'žemės naudojimo paskirties keitim',
  'žemės paskirties keitim',
  'paskirties keitimo',
];

// A cadastral number is the thing a scraper ultimately needs.
const CADASTRAL = /\d{4}\/\d{4}:\d+/;

// Where a municipality is most likely to list these notices when its search does
// not answer — vilnius.lt, the one integration that exists, publishes them as
// articles under a news category rather than anywhere a search would surface.
// The one municipality already integrated, kept here as the method's own
// control: vilnius.lt publishes these under a news category, and a bare
// /naujienos will not show one unless a notice happens to be recent. If the
// survey reports nothing for Vilnius, it is under-reporting everywhere.
const KNOWN_GOOD = 'https://vilnius.lt/naujienos/?categories=65';

const LISTING_PATHS = [
  '/naujienos/?categories=65',
  '/naujienos',
  '/skelbimai',
  '/teritoriju-planavimas',
  '/veiklos-sritys/teritoriju-planavimas',
  '/gyventojams/teritoriju-planavimas',
];

// Enough to catch a notice on a listing without crawling anyone's site.
const ARTICLES_TO_OPEN = 8;

const REQUEST_TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;

type Finding = {
  code: string;
  name: string;
  site: string | null;
  reachable: boolean;
  searchUrl: string | null;
  matchedTerms: string[];
  cadastralOnPage: boolean;
  sampleLinks: string[];
  note: string;
};

/** "Vilniaus m. sav." -> "vilniaus" — the stem as the name already gives it. */
function genitiveStem(name: string): string {
  return name
    .replace(/\s+(m\.|r\.)?\s*sav\.$/i, '')
    .trim()
    .toLowerCase()
    .replace(/ą/g, 'a')
    .replace(/č/g, 'c')
    .replace(/ę/g, 'e')
    .replace(/ė/g, 'e')
    .replace(/į/g, 'i')
    .replace(/š/g, 's')
    .replace(/ų/g, 'u')
    .replace(/ū/g, 'u')
    .replace(/ž/g, 'z')
    .replace(/\s+/g, '');
}

/** "vilniaus" -> "vilnius", the nominative most city sites use as their domain. */
function toDomainName(name: string): string {
  return genitiveStem(name)
    .replace(/iaus$/, 'ius')
    .replace(/aus$/, 'us')
    .replace(/ies$/, 'is')
    .replace(/u$/, 'ai')
    .replace(/es$/, 'e')
    .replace(/os$/, 'a')
    .replace(/o$/, 'as');
}

/**
 * District municipalities do not follow one convention — vrsa.lt, krs.lt,
 * kaunorajonas.lt and siauliuraj.lt are all real, and all four patterns had to
 * be probed to find them. Offer every candidate and let the name check decide;
 * a guess that lands on the city's site is worse than no answer.
 */
function candidateDomains(name: string): string[] {
  const stem = genitiveStem(name);
  const nominative = toDomainName(name);
  const initial = stem.slice(0, 1);
  const isDistrict = /\br\.\s*sav\.$/i.test(name);

  const names = isDistrict
    ? [
        `${stem}raj`,
        `${stem}rajonas`,
        `${initial}rsa`,
        `${initial}rs`,
        `${stem}rsa`,
        nominative,
        stem,
      ]
    : [nominative, stem, `${stem}sa`];

  return [...new Set(names)].flatMap((n) => [`https://www.${n}.lt`, `https://${n}.lt`]);
}

async function get(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': 'smalsuolis-survey/1.0 (+https://smalsuolis.lt)' },
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

/**
 * A guessed domain that belongs to a different municipality is worse than no
 * answer: vilnius.lt is not Vilniaus r. sav., and the heuristic cannot tell.
 * Only accept a site whose own page names the municipality it should be.
 */
async function resolveSite(name: string): Promise<string | null> {
  const stem = name
    .replace(/\s+(m\.|r\.)?\s*sav\.$/i, '')
    .trim()
    .toLowerCase()
    .slice(0, 6);
  const isDistrict = /\br\.\s*sav\.$/i.test(name);

  for (const candidate of candidateDomains(name)) {
    const res = await get(candidate);
    if (!res.ok) continue;
    const text = textOf(res.text).slice(0, 4000);
    if (!text.includes(stem)) continue;
    // "Vilniaus rajono savivaldybė" and "Vilniaus miesto savivaldybė" are
    // different bodies on different sites; the name must agree on which.
    if (isDistrict && !text.includes('rajono')) continue;
    if (!isDistrict && text.includes('rajono savivaldyb') && !text.includes('miesto savivaldyb'))
      continue;
    return candidate;
  }
  return null;
}

/** Common site-search shapes; the first that answers with our terms wins. */
function searchUrls(site: string, query: string): string[] {
  const q = encodeURIComponent(query);
  return [`${site}/?s=${q}`, `${site}/paieska?q=${q}`, `${site}/search?q=${q}`, `${site}/?q=${q}`];
}

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Every on-site link from a listing, in document order. */
function articleLinks(html: string, site: string, limit: number): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/gi)) {
    const raw = m[1];
    if (raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
    let href: string;
    try {
      href = new URL(raw, site).toString();
    } catch {
      continue;
    }
    if (!href.startsWith(site.replace('www.', '')) && !href.startsWith(site)) continue;
    out.add(href.split('#')[0]);
    if (out.size >= limit) break;
  }
  return [...out];
}

/**
 * A listing page rarely carries the notice text — vilnius.lt lists titles and
 * keeps "Esama pagrindinė žemės naudojimo paskirtis" inside each article. A
 * survey that only reads listings reports nothing even where a working scraper
 * already exists, so follow a few of them.
 */
async function scanArticles(links: string[], finding: Finding): Promise<boolean> {
  for (const link of links.slice(0, ARTICLES_TO_OPEN)) {
    const res = await get(link);
    if (!res.ok || !res.text) continue;

    const text = textOf(res.text);
    const matched = TERMS.filter((t) => text.includes(t));
    if (!matched.length) continue;

    finding.matchedTerms = [...new Set([...finding.matchedTerms, ...matched])];
    finding.cadastralOnPage = finding.cadastralOnPage || CADASTRAL.test(res.text);
    finding.sampleLinks = [...new Set([...finding.sampleLinks, link])].slice(0, 5);
    return true;
  }
  return false;
}

// A notice is often identifiable from the link alone — vilnius.lt puts the
// cadastral number straight into the slug.
const LINK_HINTS = ['kadastro-nr', 'zemes-sklypo', 'paskirt', 'kadastro_nr'];

function linksMentioning(html: string, site: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = textOf(m[2]);
    const href = m[1].toLowerCase();
    if (TERMS.some((t) => label.includes(t)) || LINK_HINTS.some((h) => href.includes(h))) {
      const href = m[1].startsWith('http') ? m[1] : new URL(m[1], site).toString();
      out.add(href);
    }
    if (out.size >= 5) break;
  }
  return [...out];
}

async function survey(code: string, name: string): Promise<Finding> {
  const site = await resolveSite(name);

  const finding: Finding = {
    code,
    name,
    site,
    reachable: !!site,
    searchUrl: null,
    matchedTerms: [],
    cadastralOnPage: false,
    sampleLinks: [],
    note: '',
  };

  if (!site) {
    finding.note = `svetainė neaiški — nė vienas iš ${
      candidateDomains(name).length
    } kandidatų nepasitvirtino`;
    return finding;
  }

  for (const url of searchUrls(site, 'žemės paskirties keitimas')) {
    const res = await get(url);
    if (!res.ok || !res.text) continue;

    const text = textOf(res.text);
    const matched = TERMS.filter((t) => text.includes(t));
    if (!matched.length) continue;

    finding.searchUrl = url;
    finding.matchedTerms = matched;
    finding.cadastralOnPage = CADASTRAL.test(res.text);
    finding.sampleLinks = linksMentioning(res.text, site);
    finding.note = finding.cadastralOnPage
      ? 'randama ir kadastro numerių — tinka nuskaitymui'
      : 'terminai randami, kadastro numerių paieškos puslapyje nėra';
    return finding;
  }

  // Search found nothing; try the sections these notices usually live in.
  for (const listingPath of LISTING_PATHS) {
    const url = `${site}${listingPath}`;
    const res = await get(url);
    if (!res.ok || !res.text) continue;

    const text = textOf(res.text);
    const matched = TERMS.filter((t) => text.includes(t));

    if (matched.length) {
      finding.searchUrl = url;
      finding.matchedTerms = matched;
      finding.cadastralOnPage = CADASTRAL.test(res.text);
      finding.sampleLinks = linksMentioning(res.text, site);
      finding.note = `rasta skiltyje ${listingPath}`;
      return finding;
    }

    const named = linksMentioning(res.text, site);
    const candidates = named.length ? named : articleLinks(res.text, site, 40);
    if (await scanArticles(candidates, finding)) {
      finding.searchUrl = url;
      finding.note = finding.cadastralOnPage
        ? `rasta ${listingPath} straipsniuose, su kadastro numeriais`
        : `rasta ${listingPath} straipsniuose, be kadastro numerių`;
      return finding;
    }
  }

  finding.note = 'svetainė pasiekiama, bet nei paieška, nei žinomos skiltys nieko negrąžino';
  return finding;
}

async function main() {
  const wanted = process.argv.slice(2).map((s) => s.toLowerCase());

  const res = await fetch(BOUNDARIES, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const items: Array<{ code: string; name: string }> = (await res.json()).items ?? [];

  const targets = wanted.length
    ? items.filter((m) =>
        wanted.some(
          (w) =>
            m.name.toLowerCase().includes(w) ||
            genitiveStem(m.name).includes(w) ||
            toDomainName(m.name).includes(w),
        ),
      )
    : items;

  // Prove the method still finds the one case we know exists before trusting a
  // sweep that says "nothing found" 59 times.
  const control = await get(KNOWN_GOOD);
  const controlFinding: Finding = {
    code: '',
    name: '',
    site: 'https://vilnius.lt',
    reachable: true,
    searchUrl: null,
    matchedTerms: [],
    cadastralOnPage: false,
    sampleLinks: [],
    note: '',
  };
  const controlHit =
    control.ok &&
    (TERMS.some((t) => textOf(control.text).includes(t)) ||
      (await scanArticles(articleLinks(control.text, 'https://vilnius.lt', 40), controlFinding)));
  console.log(
    `Kontrolė (vilnius.lt kategorija 65): ${
      controlHit ? 'randama ✓' : 'NERANDAMA — metodas nepatikimas ✗'
    }\n`,
  );

  console.log(`Tikrinama ${targets.length} savivaldybių\n`);

  const findings: Finding[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((m) => survey(m.code, m.name)));
    for (const f of results) {
      findings.push(f);
      const mark = f.cadastralOnPage
        ? '✓✓'
        : f.matchedTerms.length
        ? '✓ '
        : f.reachable
        ? '· '
        : '✗ ';
      console.log(`${mark} ${f.name.padEnd(26)} ${(f.site ?? '-').padEnd(30)} ${f.note}`);
    }
  }

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'municipality-landuse-survey.json');
  fs.writeFileSync(outFile, JSON.stringify(findings, null, 2));

  const withCadastral = findings.filter((f) => f.cadastralOnPage).length;
  const withTerms = findings.filter((f) => f.matchedTerms.length).length;
  console.log(
    `\nIš ${findings.length}: ${withCadastral} su kadastro numeriais, ${withTerms} su terminais, ` +
      `${findings.filter((f) => !f.reachable).length} svetainių nerasta`,
  );
  console.log(`Rezultatai: ${outFile}`);
}

main();
