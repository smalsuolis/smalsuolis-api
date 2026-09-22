import { MunicipalSource } from './municipal';

/**
 * The municipalities read from their own site instead of the central portal,
 * and why each one is here.
 *
 * The portal covers the other fifty-something and is the base. A municipality
 * earns a place in this list only by the portal failing it, because every entry
 * is a separate site with its own markup, its own outages, and its own chance
 * of quietly changing shape.
 *
 * Each entry's `slug` must match the portal slug it replaces, so that skipping
 * it there and reading it here cannot both happen.
 */
export const MUNICIPAL_SOURCES: MunicipalSource[] = [
  {
    // The portal has Klaipėda's notices, but its 2026 rows name only a street
    // address — "Žemės sklypas Klevų g. 7" — with no parcel number, which is
    // what a notice is identified by. The municipality's own table carries the
    // numbers.
    slug: 'klaipedos_m',
    name: 'Klaipėdos m.',
    reader: 'cumulative',
    urls: [
      'https://www.klaipeda.lt/lt/pagrindines-zemes-naudojimo-paskirties-ir-ar-naudojimo-budo-keitimas/pagal-bendrojo-plano-sprendinius/8961',
      'https://www.klaipeda.lt/lt/pagrindines-zemes-naudojimo-paskirties-ir-ar-naudojimo-budo-keitimas/pagal-detaliojo-plano-sprendinius/8962',
    ],
  },
  {
    // Rietavas never published to the portal at all — its page there is an
    // empty shell. Posts are read whole and filtered by content, because the
    // category a notice is filed under is set by hand and at least one sits
    // outside the category that supposedly holds them.
    slug: 'rietavo',
    name: 'Rietavo',
    reader: 'wp-rest',
    urls: ['https://www.rietavas.lt/wp-json/wp/v2/posts?_fields=id,date,link,title,content'],
    maxPages: 6,
  },
  {
    // Alytaus r. stopped publishing to the portal on 2025-08-06 and moved to
    // its own site, which picked up on 2025-08-11.
    slug: 'alytaus_raj',
    name: 'Alytaus r.',
    reader: 'listing',
    urls: [
      'https://www.arsa.lt/pagrindines-zemes-naudojimo-paskirties-ir-budo-nustatymas-keitimas/zemes-naudojimo-paskirties-keitimo-skelbimai/1198',
    ],
    // Notice URLs end in `:<id>` under the same listing path.
    // Every item under /1198/ is one of these notices — the path IS the
    // section — so no content filter: it dropped 42 of 66, because the shorter
    // "nustatyti … žemės naudojimo būdą" wording states the subject without any
    // of the phrases a filter keys on.
    itemLinkPattern: /zemes-naudojimo-paskirties-keitimo-skelbimai\/1198\/[^/]+:\d+$/,
    pageUrl: (base, offset) => `${base}/p${offset}/c0`,
    pageStep: 15,
    // arsa.lt starts refusing after roughly two dozen consecutive requests,
    // answering 200 with a firewall page. Pacing keeps the whole listing
    // readable in one run.
    requestDelayMs: 1500,
  },
];

/** Portal slugs covered by a municipal source, so the portal skips them. */
export const MUNICIPAL_SOURCE_SLUGS = MUNICIPAL_SOURCES.map((s) => s.slug);
