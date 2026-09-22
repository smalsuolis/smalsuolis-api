/**
 * Dates as these pages actually carry them.
 *
 * Three carriers, and a parser that reads only the first will mis-date whole
 * municipalities rather than fail loudly:
 *
 *   ISO          `2026-08-21`
 *   Lithuanian   `2026 m. birželio 3 d.`
 *   PDF href     `/sites/default/files/uploads/2026/07/prasymas.pdf`
 *
 * Zarasai and Radviliškis write the long form, so an ISO-only reader concludes
 * their newest notice is years old. Biržai puts almost no dates in the text at
 * all — they survive only in the upload paths of the linked PDFs.
 */

const LT_MONTHS: Record<string, number> = {
  sausio: 1,
  vasario: 2,
  kovo: 3,
  balandžio: 4,
  gegužės: 5,
  birželio: 6,
  liepos: 7,
  rugpjūčio: 8,
  rugsėjo: 9,
  spalio: 10,
  lapkričio: 11,
  gruodžio: 12,
};

const ISO_RE = /(?<![\d\-])(\d{4})-(\d{2})-(\d{2})(?![\d\-])/g;

const LT_RE = new RegExp(
  `(\\d{4})\\s*m\\.?\\s*(${Object.keys(LT_MONTHS).join('|')})\\s*(\\d{1,2})\\s*d`,
  'gi',
);

// `/uploads/2026/07/…` — year and month only, so the day is unknown.
const HREF_RE = /\/(?:uploads?|files)\/(\d{4})\/(\d{2})(?:\/(\d{2}))?\//gi;

/** An ISO `YYYY-MM-DD` string, or null when the parts do not form a real date. */
function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Every date in a chunk of text, in both written forms, sorted ascending and
 * de-duplicated. Order of appearance is deliberately discarded — these pages
 * are ordered newest-first in some municipalities and oldest-first in others,
 * so "the first date" means nothing consistent.
 */
export function extractDates(text: string): string[] {
  const found = new Set<string>();

  for (const m of text.matchAll(ISO_RE)) {
    const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.add(iso);
  }
  for (const m of text.matchAll(LT_RE)) {
    const month = LT_MONTHS[m[2].toLowerCase()];
    const iso = month ? toIso(Number(m[1]), month, Number(m[3])) : null;
    if (iso) found.add(iso);
  }

  return [...found].sort();
}

/**
 * Dates recoverable from link targets, used where the page text carries none.
 * An upload path pins the year and month but not the day, so the first of the
 * month stands in — good enough to place the notice in time and to keep the
 * synthetic id stable, which is all it is used for.
 */
export function extractDatesFromHrefs(hrefs: string[]): string[] {
  const found = new Set<string>();
  for (const href of hrefs) {
    for (const m of href.matchAll(HREF_RE)) {
      const iso = toIso(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1);
      if (iso) found.add(iso);
    }
  }
  return [...found].sort();
}

export type DateSplit = {
  /** When the notice was published. */
  publishedAt: string | null;
  /** Deadline for comments, when the record gives one. */
  deadlineAt: string | null;
  /**
   * True when publication was computed back from the deadline rather than
   * read. Surfaced so the log can distinguish a read date from a derived one.
   */
  publishedAtDerived: boolean;
};

/**
 * These pages started carrying this notice type on 2021-07-01, when the
 * publication duty came into force. Anything older in a record's text is a
 * reference to a statute or an earlier decision, not the notice's own date, so
 * it is excluded before the earliest-date rule can be misled by it.
 */
export const PUBLICATION_REGIME_START = '2021-07-01';

// `(iki 2026-09-04)`, `ne vėliau kaip 2026 m. rugsėjo 4 d.` — a date introduced
// this way is the close of the comment period, never the publication date.
const DEADLINE_HINT_RE =
  /(?:iki|ne\s+vėliau\s+kaip)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{4}\s*m\.?\s*[a-ząčęėįšųūž]+\s*\d{1,2}\s*d)/gi;

// `10 d. d.`, `10 darbo dienų` — the length of the comment window, which these
// notices state even when they never print the publication date itself.
const WORKING_DAYS_RE = /(\d{1,2})\s*(?:darbo\s+dien\w*|d\.\s*d\.)/i;

// `Vadovaudamasis Tarybos 2023 m. gegužės 12 d. sprendimu Nr. T-118` — a notice
// cites the decision it acts under, and that date is older than the notice
// itself, so taking the earliest date in a record picked the citation and dated
// a 2026 notice to 2023. The mixin then treated it as historical and it reached
// no subscriber.
//
// The case ending is what separates the two, and getting this wrong is
// expensive in the other direction: Šiauliai announces its own decisions as
// "Informuojame apie 2026-07-01 priimtą … mero potvarkį", where the date IS the
// notice's. Matching the word stem alone left 1,355 records undated nationwide.
// Only the instrumental — "sprendimu", "įsakymu", "potvarkiu", "patvirtintu",
// answering "under what" — marks a document being cited; the accusative
// ("potvarkį", "sprendimą") marks the one being announced.
const CITATION_RE = new RegExp(
  `(\\d{4}-\\d{2}-\\d{2}|\\d{4}\\s*m\\.?\\s*[a-ząčęėįšųūž]+\\s*\\d{1,2}\\s*d\\.?)` +
    `[^.;]{0,40}?\\b(?:sprendimu|įsakymu|nutarimu|potvarkiu|patvirtint\\w*)\\b`,
  'gi',
);

/** Dates that belong to a document the notice refers to, not to the notice. */
export function extractCitedDates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) {
    for (const iso of extractDates(m[1])) found.add(iso);
  }
  return [...found].sort();
}

/** Dates explicitly marked as a deadline by the wording around them. */
export function extractDeadlineDates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(DEADLINE_HINT_RE)) {
    for (const iso of extractDates(m[1])) found.add(iso);
  }
  return [...found].sort();
}

/** The stated length of the comment window in working days, when given. */
export function extractWorkingDayWindow(text: string): number | null {
  const m = WORKING_DAYS_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 60 ? n : null;
}

/**
 * Step back `days` working days from an ISO date, skipping weekends.
 *
 * Public holidays are not modelled: they would move the result by a day or two
 * at most, and this is only used to place a notice that never printed its own
 * publication date.
 */
export function subtractWorkingDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Work out when a record was published and when its comment period closes.
 *
 * A notice carries two dates with opposite meanings — the day the request was
 * received and the day comments close — and the deadline is always the larger
 * number. So neither "the newest date" nor "the first date on the page" is
 * right: the first picks the deadline, and the second depends on a sort order
 * that differs between municipalities. Both dates are usually in the past, most
 * records being historical, so "in the future" does not identify the deadline
 * either.
 *
 * The rules that do hold, in order:
 *   - a heading date (a block that is nothing but a date) is authoritative;
 *   - a date introduced by "iki" is the deadline, never publication;
 *   - a date attached to a decision the notice cites belongs to that decision;
 *   - otherwise publication is the earliest plausible date left;
 *   - where the record gives only a deadline, publication is computed back
 *     across the comment window the notice itself states (Raseiniai writes
 *     "10 d. d. nuo prašymo paskelbimo datos (iki 2026-09-04)" and never prints
 *     the publication date at all).
 */
export function splitDates(
  dates: string[],
  opts: { headingDate?: string | null; text?: string } = {},
): DateSplit {
  const text = opts.text ?? '';
  const flagged = new Set(extractDeadlineDates(text));
  const cited = new Set(extractCitedDates(text));
  const plausible = dates.filter((d) => d >= PUBLICATION_REGIME_START).sort();
  const candidates = plausible.filter((d) => !flagged.has(d) && !cited.has(d));

  const headingDate = opts.headingDate ?? null;
  const readPublishedAt = headingDate ?? (candidates.length ? candidates[0] : null);
  const latest = (() => {
    const usable = plausible.filter((d) => !cited.has(d));
    return usable.length ? usable[usable.length - 1] : null;
  })();

  if (readPublishedAt) {
    return {
      publishedAt: readPublishedAt,
      deadlineAt: latest && latest > readPublishedAt ? latest : null,
      publishedAtDerived: false,
    };
  }

  const deadlineAt = [...flagged].sort().pop() ?? latest;
  if (!deadlineAt) return { publishedAt: null, deadlineAt: null, publishedAtDerived: false };

  const window = extractWorkingDayWindow(text);
  return {
    publishedAt: window ? subtractWorkingDays(deadlineAt, window) : null,
    deadlineAt,
    publishedAtDerived: !!window,
  };
}
