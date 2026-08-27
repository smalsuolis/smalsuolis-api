import { parse } from 'node-html-parser';

/**
 * Finding the notice pages on planuojustatau.lt.
 *
 * The path cannot be constructed. Ten municipalities have no plain
 * `pagal_20_2_2` page at all, seventeen have several, and the current data sits
 * in the last of them rather than the first. The names are not systematic
 * either — `pagal_20_2_2_nuo_2024401` is missing a digit,
 * `pagal_20_2_2_iki_nuo_2026` contradicts itself, and one municipality's own
 * slug is misspelled (`ignalinos_jar`). Every path is therefore read from an
 * index rather than assembled.
 */

export const PORTAL_BASE = 'https://www.planuojustatau.lt';

/** The index listing every municipality's notice section. */
const INDEX_SLUG = 'savivaldybes_vietoves_lygmens_tpd';
export const MUNICIPALITY_INDEX_PATH = `/lt/planuoju_rtpd/${INDEX_SLUG}`;

export type MunicipalitySection = {
  /** Portal slug, e.g. `zarasu_raj`. */
  slug: string;
  /** Name as the portal writes it, e.g. `Zarasų raj.`. */
  name: string;
  path: string;
};

const SECTION_HREF_RE = /^\/(?:lt\/)?planuoju_rtpd\/([a-z0-9_]+)$/i;
const NOTICE_HREF_RE = /^\/(?:lt\/)?planuoju_rtpd\/([a-z0-9_]+)\/(pagal_20_2_2[a-z0-9_]*)$/i;

/** Every municipality section linked from the index page. */
export function parseMunicipalityIndex(html: string): MunicipalitySection[] {
  const root = parse(html);
  const seen = new Map<string, MunicipalitySection>();

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const m = SECTION_HREF_RE.exec(href);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    // The index links to itself in the breadcrumb; it is not a municipality.
    if (slug === INDEX_SLUG || seen.has(slug)) continue;
    const name = a.text.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    seen.set(slug, { slug, name, path: `/lt/planuoju_rtpd/${slug}` });
  }

  return [...seen.values()];
}

/**
 * The land-use notice pages inside one municipality's section, in the order the
 * portal lists them.
 *
 * All of them are returned, not just the newest-looking one: the names give no
 * reliable ordering, and a municipality's current notices sit in whichever page
 * it last decided to use.
 */
export function parseNoticePagePaths(html: string, slug: string): string[] {
  const root = parse(html);
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const m = NOTICE_HREF_RE.exec(href);
    if (!m || m[1].toLowerCase() !== slug.toLowerCase()) continue;
    const path = `/lt/planuoju_rtpd/${m[1]}/${m[2]}`;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return paths;
}
