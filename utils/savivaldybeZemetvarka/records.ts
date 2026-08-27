import { createHash } from 'crypto';
import { parse, HTMLElement } from 'node-html-parser';
import { extractDates, extractDatesFromHrefs, splitDates } from './dates';
import { extractParcelIds, hasParcelId, ParcelIds } from './cadastral';

/**
 * Turning a cumulative notice page into individual records.
 *
 * The Vilnius integration tracks one article per URL, so a new URL means a new
 * notice. That does not carry over here: most municipalities publish every
 * notice they have ever issued into one long page with no per-notice link. Some
 * pages put the newest notice at the top, some at the bottom, and all of them
 * get edited in place. So a record's identity cannot come from its URL, its
 * position, or its neighbours — only from its own content.
 *
 * Records are anchored on the parcel identifier rather than on a date heading,
 * because the identifier is the one field every municipality writes (the
 * wording around it is free text and differs everywhere, and Biržai barely
 * writes dates into the page at all).
 */

// Drupal's body field. Scoping to it excludes the site navigation, which
// otherwise contributes ~72 list items of chrome to every page.
/**
 * Where a page keeps its notices, tried in order.
 *
 * Scoping to a content container matters: site navigation contributes dozens of
 * list items of chrome to every page, and a whole-document read turns them into
 * phantom blocks. Municipality sites each name their container differently, so
 * a source may supply its own; these are the defaults that cover the common
 * CMSes, with the document body as a last resort so an unknown template
 * degrades to noisy rather than empty.
 */
const DEFAULT_CONTENT_SELECTORS = [
  '.field--name-body',
  '.region-content article .content',
  '.plain_content',
  '.formatted_text',
  '.news_content',
  'article',
  'main',
  'body',
];

const BLOCK_TAGS = ['p', 'li', 'td', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'];

// How far back to look for a date heading that belongs to the record below it.
// Zarasai separates the two with a blank paragraph; three covers that with room
// to spare without reaching into the previous record.
const HEADING_LOOKBEHIND = 3;

export type Block = {
  text: string;
  hrefs: string[];
};

export type PortalRecord = {
  /** Stable identity for this notice within its municipality. */
  syntheticId: string;
  title: string;
  body: string;
  publishedAt: string | null;
  deadlineAt: string | null;
  /** True when publishedAt was computed back from the deadline, not read. */
  publishedAtDerived: boolean;
  kind: RecordKind;
  parcels: ParcelIds;
  hrefs: string[];
};

const collapse = (s: string) => s.replace(/[\s ]+/g, ' ').trim();

/**
 * True when a block is nothing but a date — a heading introducing the notice
 * below it, rather than prose that happens to mention a date.
 */
export function isDateHeading(text: string): boolean {
  const t = collapse(text);
  if (!t || t.length > 40) return false;
  const dates = extractDates(t);
  if (dates.length !== 1) return false;

  // Strip the written date, in either form, and see whether anything of
  // substance is left over.
  const withoutDate = t
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d{4}\s*m\.?\s*[a-ząčęėįšųūž]+\s*\d{1,2}\s*d\.?/gi, '');
  return !/[a-ząčęėįšųūž\d]/i.test(withoutDate);
}

/**
 * The text a block owns directly, excluding anything belonging to a block-level
 * child.
 *
 * These pages are pasted out of Word, which emits `<p>2026-08-17<p></p></p>` —
 * a paragraph nested inside a paragraph. Treating only childless elements as
 * blocks throws that date away with the wrapper, and the notice loses its date
 * while the page plainly shows one.
 */
function ownText(el: HTMLElement): string {
  let out = '';
  for (const node of el.childNodes) {
    const child = node as HTMLElement;
    const tag = child.tagName?.toLowerCase();
    if (tag && BLOCK_TAGS.includes(tag)) continue;
    out += child.text ?? '';
  }
  return collapse(out);
}

/** Links owned directly by a block, on the same basis as its text. */
function ownHrefs(el: HTMLElement): string[] {
  const hrefs: string[] = [];
  for (const node of el.childNodes) {
    const child = node as HTMLElement;
    const tag = child.tagName?.toLowerCase();
    if (tag && BLOCK_TAGS.includes(tag)) continue;
    if (tag === 'a') {
      const href = child.getAttribute?.('href');
      if (href) hrefs.push(href);
    }
    if (child.querySelectorAll) {
      for (const a of child.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href) hrefs.push(href);
      }
    }
  }
  return hrefs;
}

/**
 * Flatten the content region into an ordered list of text blocks.
 *
 * Each block carries only the text it owns, so a wrapping element does not
 * repeat everything inside it and a Word-nested one does not swallow its own.
 */
export function flattenBlocks(html: string, contentSelectors?: string[]): Block[] {
  const root = parse(html);
  let content: HTMLElement | null = null;
  for (const selector of contentSelectors?.length ? contentSelectors : DEFAULT_CONTENT_SELECTORS) {
    content = root.querySelector(selector);
    if (content) break;
  }
  if (!content) return [];

  const blocks: Block[] = [];
  for (const el of content.querySelectorAll(BLOCK_TAGS.join(','))) {
    const text = ownText(el);
    const hrefs = ownHrefs(el);
    if (!text && !hrefs.length) continue;
    blocks.push({ text, hrefs });
  }
  return blocks;
}

/**
 * Which stage of the process a notice reports.
 *
 * Municipalities publish two different things under the same heading: a request
 * still open for public comment, and a decision already taken. Smalsuolis is
 * most useful for the first — there is still something a reader can do about it
 * — so the two are told apart rather than lumped together.
 *
 * It also separates two notices that would otherwise be indistinguishable: the
 * request and the decision for one parcel are frequently published on the same
 * day, with the same parcel number, and differ only in this.
 */
export type RecordKind = 'request' | 'decision' | 'unknown';

// The legal formulas are stable even though the prose around them is not: a
// decision is written in the first person by the official taking it
// ("Vadovaudamasis … pakeičiu"), a request in the third ("Informuojame, kad …
// gautas prašymas").
const DECISION_RE = /vadovaudamasi|įsakau|pakeičiu|nustatau|potvark|įsakym|sprendim/i;
const REQUEST_RE = /prašym|informuojame,\s*kad\s+(?:yra\s+)?(?:gaut|pateikt)|ketinim/i;

export function classifyKind(text: string): RecordKind {
  const decision = DECISION_RE.test(text);
  const request = REQUEST_RE.test(text);
  if (decision && !request) return 'decision';
  if (request && !decision) return 'request';
  // Both formulas present: a decision quoting the request it answers. The
  // first-person verb is the operative one.
  if (decision && request) return /įsakau|pakeičiu|nustatau/i.test(text) ? 'decision' : 'request';
  return 'unknown';
}

/** The parcels a block names, as a comparable key. */
function parcelSignature(text: string): string {
  const { cadastrals, uniqueNumbers } = extractParcelIds(text);
  return [...cadastrals, ...uniqueNumbers].join(',');
}

/**
 * Group flattened blocks into records.
 *
 * A block naming a parcel opens a record and the blocks after it belong to it,
 * up to the next date heading or the next block naming *different* parcels.
 *
 * The "different" matters: these notices repeat the parcel number in the
 * heading and again in the sentence below it ("PRAŠYMAS DĖL ŽEMĖS SKLYPO (KAD.
 * NR. 4374/0001:63)…" followed by "Informuojame, kad … (kad., Nr.
 * 4374/0001:63) …"). Treating every parcel mention as a new record splits one
 * notice into two — a title fragment with no dates and a body fragment with no
 * title.
 */
export function groupRecords(blocks: Block[]): Omit<PortalRecord, 'syntheticId'>[] {
  const anchors: { index: number; signature: string }[] = [];
  blocks.forEach((b, i) => {
    const signature = parcelSignature(b.text);
    if (signature) anchors.push({ index: i, signature });
  });

  // Consecutive anchors repeating the same parcels are one notice, unless a
  // date heading between them says otherwise.
  const starts: number[] = [];
  anchors.forEach((anchor, n) => {
    const prev = anchors[n - 1];
    if (!prev) {
      starts.push(anchor.index);
      return;
    }
    const separated = blocks.slice(prev.index + 1, anchor.index).some((b) => isDateHeading(b.text));
    if (anchor.signature !== prev.signature || separated) starts.push(anchor.index);
  });

  return starts.map((start, n) => {
    const nextStart = starts[n + 1] ?? blocks.length;
    let end = nextStart;
    // Stop at a date heading: it introduces the next notice, and its date must
    // not be read as this record's deadline.
    for (let i = start + 1; i < nextStart; i++) {
      if (isDateHeading(blocks[i].text)) {
        end = i;
        break;
      }
    }

    const own = blocks.slice(start, end);
    const text = own
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n');
    const hrefs = own.flatMap((b) => b.hrefs);

    let headingDate: string | null = null;
    for (let i = start - 1; i >= Math.max(0, start - HEADING_LOOKBEHIND); i--) {
      if (isDateHeading(blocks[i].text)) {
        headingDate = extractDates(blocks[i].text)[0] ?? null;
        break;
      }
      if (parcelSignature(blocks[i].text)) break;
    }

    const dates = [...extractDates(text), ...extractDatesFromHrefs(hrefs)];
    const { publishedAt, deadlineAt, publishedAtDerived } = splitDates(dates, {
      headingDate,
      text,
    });

    return {
      title: collapse(own[0]?.text ?? '').slice(0, 500),
      body: text,
      publishedAt,
      deadlineAt,
      publishedAtDerived,
      kind: classifyKind(text),
      parcels: extractParcelIds(text),
      hrefs,
    };
  });
}

/**
 * Identity for one notice, stable across runs.
 *
 * Built only from what makes the notice what it is — the municipality, the
 * parcels it concerns, and the day it was published. Deliberately independent
 * of position on the page, of the surrounding prose, and of the page's sort
 * order, all of which change without the notice changing.
 *
 * The parcel list is already sorted and normalised by extractParcelIds, so two
 * spellings or two orderings of the same parcels produce the same id.
 */
export function syntheticId(
  municipalitySlug: string,
  parcels: ParcelIds,
  publishedAt: string | null,
  kind: RecordKind = 'unknown',
): string {
  const parts = [...parcels.cadastrals, ...parcels.uniqueNumbers].join(',');
  const digest = createHash('sha1')
    .update(`${parts}|${publishedAt ?? ''}|${kind}`)
    .digest('hex')
    .slice(0, 12);
  return `portal:${municipalitySlug}:${digest}`;
}

/** Parse one municipality's notice page into identified records. */
export function parsePortalPage(
  html: string,
  municipalitySlug: string,
  contentSelectors?: string[],
): PortalRecord[] {
  return groupRecords(flattenBlocks(html, contentSelectors))
    .filter((r) => r.parcels.cadastrals.length || r.parcels.uniqueNumbers.length)
    .map((r) => ({
      ...r,
      syntheticId: syntheticId(municipalitySlug, r.parcels, r.publishedAt, r.kind),
    }));
}
