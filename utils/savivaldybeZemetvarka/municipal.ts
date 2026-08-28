import { parse } from 'node-html-parser';
import { extractParcelIds } from './cadastral';
import { extractDates, extractDatesFromHrefs, splitDates } from './dates';
import { classifyKind, parsePortalPage, syntheticId } from './records';
import { Fetcher, MunicipalityRunStats, SourceRecord, SourceResult } from './sources';
import { looksBlocked } from './blocked';

/** externalId namespace for notices read from a municipality's own site. */
export const MUNICIPAL_PREFIX = 'sav';

/** The externalId prefix one municipal source's events all share. */
export const municipalCleanupPrefix = (slug: string) => `${MUNICIPAL_PREFIX}:${slug}:`;

/**
 * Municipalities read from their own site rather than from the central portal.
 *
 * The portal covers the country, so this is only for the places where it does
 * not: Rietavas never posted there, Alytaus r. stopped in 2025, and Klaipėda's
 * copy on the portal identifies its 2026 notices by street address with no
 * parcel number at all.
 *
 * Three shapes cover them. A cumulative page is the portal's own shape and
 * needs no new reading. A listing needs following into each notice. A
 * WordPress REST feed hands over posts as JSON but with no category worth
 * trusting, so the notices are picked out by what they say.
 */

/** Notices of this kind cite the article they are published under. */
const LAND_USE_RE =
  /20\s*straipsnio\s*2\s*dalies\s*2\s*punkt|pagrindin(?:ės|ę|es)\s+žemės\s+naudojimo\s+paskirt|naudojimo\s+būd[oąa]\s*(?:keitim|pakeitim|nustatym)/i;

/**
 * Whether a document is one of these notices at all.
 *
 * Needed because the feeds these come from are not dedicated: Rietavas mixes
 * them into general announcements, where neglected-property and unused-plot
 * notices also carry parcel numbers and would otherwise be collected as
 * land-use changes.
 */
export function isLandUseNotice(text: string): boolean {
  return LAND_USE_RE.test(text);
}

export type MunicipalSource = {
  slug: string;
  name: string;
  /** How the notices are laid out. */
  reader: 'cumulative' | 'listing' | 'wp-rest';
  /** Listing/cumulative pages, or the WordPress posts endpoint. */
  urls: string[];
  /** Where the notices sit, when the defaults do not find them. */
  contentSelectors?: string[];
  /** listing: which links lead to a notice. */
  itemLinkPattern?: RegExp;
  /** listing: how the next page is addressed, given a zero-based offset. */
  pageUrl?: (base: string, offset: number) => string;
  /** listing: how far to page before giving up. */
  pageStep?: number;
  maxPages?: number;
  /** Pause between item fetches, ms. arsa.lt starts refusing after ~24. */
  requestDelayMs?: number;
  /**
   * Keep only documents that read like a land-use notice.
   *
   * Needed where the feed is not dedicated — Rietavas mixes these into general
   * announcements, and neglected-property notices there carry parcel numbers
   * too. Harmful where the page IS the section: Klaipėda's table states the
   * subject in the page heading and its rows say only "Žemės sklypas, kadastro
   * Nr. …", so filtering on the row text drops every one of them.
   */
  filterByContent?: boolean;
};

const emptyStats = (source: MunicipalSource): MunicipalityRunStats => ({
  slug: source.slug,
  name: source.name,
  pages: 0,
  bytes: 0,
  blocks: 0,
  blocksWithParcel: 0,
  records: 0,
  datedRecords: 0,
  newestDateOnPage: null,
  newestRecordDate: null,
});

const noteRecord = (stat: MunicipalityRunStats, publishedAt: string | null) => {
  stat.records++;
  if (!publishedAt) return;
  stat.datedRecords++;
  if (!stat.newestRecordDate || publishedAt > stat.newestRecordDate) {
    stat.newestRecordDate = publishedAt;
  }
};

/** A cumulative page reads exactly as the portal's does. */
async function readCumulative(
  source: MunicipalSource,
  fetcher: Fetcher,
  stat: MunicipalityRunStats,
): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const url of source.urls) {
    const html = await fetcher(url);
    stat.pages++;
    stat.bytes += html.length;
    for (const rec of parsePortalPage(
      html,
      source.slug,
      source.contentSelectors,
      MUNICIPAL_PREFIX,
    )) {
      if (source.filterByContent && !isLandUseNotice(rec.body)) continue;
      noteRecord(stat, rec.publishedAt);
      records.push({
        source: source.slug,
        externalId: rec.syntheticId,
        municipalitySlug: source.slug,
        municipalityName: source.name,
        title: rec.title,
        body: rec.body,
        publishedAt: rec.publishedAt,
        deadlineAt: rec.deadlineAt,
        kind: rec.kind,
        parcels: rec.parcels,
        url,
      });
    }
  }
  return records;
}

/**
 * A listing of notices, each on its own page.
 *
 * Paging stops when a page introduces no link that has not already been seen,
 * rather than at a fixed count — these listings grow, and a hardcoded last page
 * silently stops collecting the newest notices once it is passed.
 */
async function readListing(
  source: MunicipalSource,
  fetcher: Fetcher,
  stat: MunicipalityRunStats,
): Promise<SourceRecord[]> {
  const step = source.pageStep ?? 15;
  const maxPages = source.maxPages ?? 40;
  const links = new Set<string>();

  for (const base of source.urls) {
    for (let page = 0; page < maxPages; page++) {
      const url = page === 0 ? base : source.pageUrl?.(base, page * step) ?? base;
      let html: string;
      try {
        html = await fetcher(url);
      } catch {
        break;
      }
      stat.pages++;
      stat.bytes += html.length;

      let added = 0;
      for (const a of parse(html).querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (!source.itemLinkPattern?.test(href)) continue;
        const absolute = href.startsWith('http') ? href : new URL(href, base).toString();
        if (links.has(absolute)) continue;
        links.add(absolute);
        added++;
      }
      if (!added || !source.pageUrl) break;
    }
  }

  const records: SourceRecord[] = [];
  let blocked = 0;
  let failed = 0;
  for (const link of links) {
    if (source.requestDelayMs) await new Promise((r) => setTimeout(r, source.requestDelayMs));
    let html: string;
    try {
      html = await fetcher(link);
    } catch {
      failed++;
      continue;
    }
    // A refusal arrives as a 200 with a firewall page. Counted rather than
    // skipped: silently dropping these is how two thirds of a municipality's
    // notices disappear while the run still reports success.
    if (looksBlocked(html)) {
      blocked++;
      continue;
    }
    stat.bytes += html.length;
    const root = parse(html);
    const text = root
      .querySelectorAll('h1,h2,h3,p,td,li')
      .map((el) => el.text)
      .join('\n')
      .replace(/[\s ]+/g, ' ');
    if (source.filterByContent && !isLandUseNotice(text)) continue;

    const parcels = extractParcelIds(text);
    if (!parcels.cadastrals.length && !parcels.uniqueNumbers.length) continue;

    const hrefs = root.querySelectorAll('a[href]').map((a) => a.getAttribute('href') || '');
    const dates = [...extractDates(text), ...extractDatesFromHrefs(hrefs)];
    const { publishedAt, deadlineAt, publishedAtDerived } = splitDates(dates, { text });
    const kind = classifyKind(text);
    const title = (root.querySelector('h1')?.text ?? text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);

    noteRecord(stat, publishedAt);
    if (publishedAt && (!stat.newestDateOnPage || publishedAt > stat.newestDateOnPage)) {
      stat.newestDateOnPage = publishedAt;
    }
    records.push({
      source: source.slug,
      externalId: syntheticId(source.slug, parcels, publishedAt, kind, MUNICIPAL_PREFIX),
      municipalitySlug: source.slug,
      municipalityName: source.name,
      title,
      body: text.slice(0, 4000),
      publishedAt,
      deadlineAt,
      kind,
      parcels,
      url: link,
      ...(publishedAtDerived ? {} : {}),
    });
  }

  if (blocked || failed) {
    const detail = `${blocked} refused, ${failed} unreachable of ${links.size}`;
    // Losing a few is worth reporting; losing most means the run did not
    // observe the municipality at all and must not pass as a success.
    if (blocked + failed > links.size / 2) {
      throw new Error(`${source.slug}: upstream refused most of the listing (${detail})`);
    }
    stat.error = `partial: ${detail}`;
  }
  return records;
}

type WpPost = {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
};

/**
 * A WordPress REST feed.
 *
 * Every post is fetched rather than a category filtered, because the category a
 * notice lands in is set by hand and is not reliable — at least one land-use
 * notice sits outside the category that supposedly holds them. The notices are
 * then picked out by what they say, which does not depend on an editor's
 * choice.
 */
async function readWpRest(
  source: MunicipalSource,
  fetcher: Fetcher,
  stat: MunicipalityRunStats,
): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];

  for (const base of source.urls) {
    for (let page = 1; page <= (source.maxPages ?? 10); page++) {
      const url = `${base}${base.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
      let posts: WpPost[];
      try {
        posts = JSON.parse(await fetcher(url));
      } catch {
        break;
      }
      if (!Array.isArray(posts) || !posts.length) break;
      stat.pages++;

      for (const post of posts) {
        const text = `${post.title?.rendered ?? ''}\n${post.content?.rendered ?? ''}`
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/[\s ]+/g, ' ');
        // Always filtered: a WordPress posts feed is the whole site.
        if (!isLandUseNotice(text)) continue;

        const parcels = extractParcelIds(text);
        if (!parcels.cadastrals.length && !parcels.uniqueNumbers.length) continue;

        const postDate = post.date?.slice(0, 10) ?? null;
        const dates = [...extractDates(text), ...(postDate ? [postDate] : [])];
        const { deadlineAt } = splitDates(dates, { text });
        const kind = classifyKind(text);

        noteRecord(stat, postDate);
        if (postDate && (!stat.newestDateOnPage || postDate > stat.newestDateOnPage)) {
          stat.newestDateOnPage = postDate;
        }
        records.push({
          source: source.slug,
          externalId: syntheticId(source.slug, parcels, postDate, kind, MUNICIPAL_PREFIX),
          municipalitySlug: source.slug,
          municipalityName: source.name,
          title: (post.title?.rendered ?? '')
            .replace(/<[^>]+>/g, '')
            .trim()
            .slice(0, 500),
          body: text.slice(0, 4000),
          // The post's own date is the publication date; a date inside the text
          // is the request's receipt date or the comment deadline, neither of
          // which is when this went up.
          publishedAt: postDate,
          deadlineAt: deadlineAt && postDate && deadlineAt > postDate ? deadlineAt : null,
          kind,
          parcels,
          url: post.link ?? base,
        });
      }
    }
  }
  return records;
}

/** Read one municipality's own site, whatever shape it publishes in. */
export async function fetchMunicipalSource(
  source: MunicipalSource,
  fetcher: Fetcher,
): Promise<SourceResult> {
  const stat = emptyStats(source);
  try {
    const records =
      source.reader === 'cumulative'
        ? await readCumulative(source, fetcher, stat)
        : source.reader === 'listing'
        ? await readListing(source, fetcher, stat)
        : await readWpRest(source, fetcher, stat);
    stat.blocksWithParcel = records.length;
    return { records, stats: [stat] };
  } catch (err: any) {
    stat.error = err?.message ?? String(err);
    return { records: [], stats: [stat] };
  }
}
