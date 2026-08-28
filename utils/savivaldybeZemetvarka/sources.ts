import { ParcelIds } from './cadastral';
import { extractDates } from './dates';
import { flattenBlocks, parsePortalPage, pickNoticeUrl, RecordKind } from './records';
import {
  MUNICIPALITY_INDEX_PATH,
  PORTAL_BASE,
  parseMunicipalityIndex,
  parseNoticePagePaths,
} from './portal';

/** One notice, in the shape every source hands to the integration. */
export type SourceRecord = {
  /** Which source produced it — also the namespace of its externalId. */
  source: string;
  externalId: string;
  municipalitySlug: string;
  municipalityName: string;
  title: string;
  body: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  kind: RecordKind;
  parcels: ParcelIds;
  url: string;
};

/**
 * What one municipality yielded in one run.
 *
 * "Nothing new on the portal" means three different things, and confusing them
 * is expensive: the municipality genuinely has no requests; it stopped
 * publishing here and moved elsewhere; or the data is there and the parser
 * cannot see it. Left undistinguished, the third looks exactly like the first
 * and the data is lost quietly.
 *
 * `newestDateOnPage` is read straight off the raw text, independently of
 * whether any record was built from it. When it runs ahead of
 * `newestRecordDate`, the page is publishing and the parser is not keeping up —
 * the third case, stated rather than inferred.
 *
 * Only dates at or before the run date count towards it. These notices state a
 * comment deadline weeks into the future, and a deadline is always later than
 * the publication date it belongs to, so counting future dates would report
 * every healthy municipality as behind.
 */
export type MunicipalityRunStats = {
  slug: string;
  name: string;
  pages: number;
  records: number;
  datedRecords: number;
  /**
   * Records whose publication date was computed back from a comment deadline
   * rather than read. Raseiniai prints no publication date at all, so its dates
   * rest entirely on that derivation — worth seeing in the log if it drifts.
   */
  derivedDates: number;
  newestDateOnPage: string | null;
  newestRecordDate: string | null;
  error?: string;
};

export type SourceResult = {
  records: SourceRecord[];
  stats: MunicipalityRunStats[];
};

export type Fetcher = (url: string) => Promise<string>;

/**
 * Municipalities the portal source must not read, because a dedicated source
 * covers them better and both writing would double every notice.
 */
export type PortalOptions = {
  skipSlugs?: string[];
  onProgress?: (message: string) => void;
  /** Run date, as `YYYY-MM-DD`. Injected so the gap check is testable. */
  today?: string;
};

/**
 * Read every municipality's notice pages off planuojustatau.lt.
 *
 * Paths are discovered rather than constructed — see portal.ts for why — and a
 * municipality that fails is recorded and stepped over, so one broken page does
 * not cost the other fifty-nine.
 */
export async function fetchPortalRecords(
  fetcher: Fetcher,
  options: PortalOptions = {},
): Promise<SourceResult> {
  const skip = new Set(options.skipSlugs ?? []);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const sections = parseMunicipalityIndex(
    await fetcher(`${PORTAL_BASE}${MUNICIPALITY_INDEX_PATH}`),
  );

  const records: SourceRecord[] = [];
  const stats: MunicipalityRunStats[] = [];

  for (const section of sections) {
    if (skip.has(section.slug)) continue;

    const stat: MunicipalityRunStats = {
      slug: section.slug,
      name: section.name,
      pages: 0,
      records: 0,
      datedRecords: 0,
      derivedDates: 0,
      newestDateOnPage: null,
      newestRecordDate: null,
    };

    try {
      const paths = parseNoticePagePaths(
        await fetcher(`${PORTAL_BASE}${section.path}`),
        section.slug,
      );
      stat.pages = paths.length;

      for (const path of paths) {
        const url = `${PORTAL_BASE}${path}`;
        const html = await fetcher(url);

        for (const block of flattenBlocks(html)) {
          const past = extractDates(block.text).filter((d) => d <= today);
          const newest = past[past.length - 1];
          if (newest && (!stat.newestDateOnPage || newest > stat.newestDateOnPage)) {
            stat.newestDateOnPage = newest;
          }
        }

        for (const record of parsePortalPage(html, section.slug)) {
          stat.records++;
          if (record.publishedAtDerived) stat.derivedDates++;
          if (record.publishedAt) {
            stat.datedRecords++;
            if (!stat.newestRecordDate || record.publishedAt > stat.newestRecordDate) {
              stat.newestRecordDate = record.publishedAt;
            }
          }
          records.push({
            source: 'portal',
            externalId: record.syntheticId,
            municipalitySlug: section.slug,
            municipalityName: section.name,
            title: record.title,
            body: record.body,
            publishedAt: record.publishedAt,
            deadlineAt: record.deadlineAt,
            kind: record.kind,
            parcels: record.parcels,
            // The municipality's own page for this notice where the portal
            // links it; the cumulative page otherwise, which is a wall of
            // hundreds of unrelated notices to land a reader in.
            url: pickNoticeUrl(record.hrefs, url),
          });
        }
      }
    } catch (err: any) {
      stat.error = err?.message ?? String(err);
    }

    stats.push(stat);
    options.onProgress?.(formatMunicipalityStat(stat));
  }

  return { records, stats };
}

/** One log line per municipality, carrying enough to tell the three cases apart. */
export function formatMunicipalityStat(s: MunicipalityRunStats): string {
  if (s.error) return `${s.slug}: FAILED — ${s.error}`;
  const lag =
    s.newestDateOnPage && (!s.newestRecordDate || s.newestRecordDate < s.newestDateOnPage)
      ? ` PARSER_BEHIND(page=${s.newestDateOnPage} parsed=${s.newestRecordDate ?? 'none'})`
      : '';
  const derived = s.derivedDates ? ` derivedDates=${s.derivedDates}` : '';
  return (
    `${s.slug}: pages=${s.pages} records=${s.records} dated=${s.datedRecords}${derived} ` +
    `newest=${s.newestRecordDate ?? 'none'}${lag}`
  );
}

/**
 * Municipalities whose pages are publishing dates the parser produced no record
 * for. This is the failure that hides: the page looks alive, the integration
 * reports success, and the notices are silently absent.
 */
export function findParserGaps(stats: MunicipalityRunStats[]): MunicipalityRunStats[] {
  return stats.filter(
    (s) =>
      !s.error &&
      s.newestDateOnPage &&
      (!s.newestRecordDate || s.newestRecordDate < s.newestDateOnPage),
  );
}
