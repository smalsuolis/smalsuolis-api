/**
 * Parcel identifiers as municipalities actually write them.
 *
 * Two different identifiers appear in these notices and they are not
 * interchangeable:
 *
 *   cadastral number  `4337/0005:391`   cadastral area / block : parcel
 *   unique number     `4400-0031-3262`  a flat registry id
 *
 * A unique number must never be re-punctuated into a cadastral number.
 * `7213-0002-0086` rewritten as `7213/0002:0086` names a parcel that does not
 * exist — the registry answers that lookup with `7213/0005:0086` — and every
 * `4400-*` number has no arithmetic relationship to a cadastral number at all.
 * Unique numbers are therefore resolved through the registry, never rewritten.
 *
 * The hyphenated 4-4-4 shape is genuinely ambiguous: it is how Raseiniai writes
 * unique numbers, and how some municipalities write cadastral numbers. Shape
 * alone cannot settle it, so both readings are offered to the registry and the
 * one it confirms wins (see resolveParcels).
 */

// `4337/0005:391`, `8730/0002:0248`, `6860/0013: 115` — municipalities pad and
// space all three groups inconsistently.
const CADASTRAL_RE = /(?<![\d\-/:])(\d{4})\s*\/\s*(\d{1,4})\s*:\s*(\d{1,4})(?![\d\-/:])/;

// `7240-0001-0086`. Strictly four digits per group, which is what keeps this
// apart from an ISO date: `2023-01-05` is 4-2-2 and can never be 4-4-4. A looser
// `\d{4}-\d{1,4}-\d{1,4}` matches every ISO date on the page — these pages carry
// hundreds of them, so that mistake silently fills the parcel list with dates.
const UNIQUE_RE = /(?<![\d\-/:])(\d{4})\s*-\s*(\d{4})\s*-\s*(\d{4})(?![\d\-/:])/;

const globally = (re: RegExp) => new RegExp(re.source, 'g');

/**
 * `4337/0005:391` → `4337/0005:0391`.
 *
 * Zero padding only, so two spellings of one parcel collapse to one key. The
 * identifier is never restructured into the other notation.
 */
export function normalizeCadastral(raw: string): string | null {
  const m = CADASTRAL_RE.exec(raw);
  if (!m) return null;
  return `${m[1]}/${m[2].padStart(4, '0')}:${m[3].padStart(4, '0')}`;
}

/**
 * `4400-0031-3262` → `440000313262`, the form the registry's `unique_numbers`
 * filter expects: separators dropped, groups already four digits wide.
 */
export function normalizeUniqueNumber(raw: string): string | null {
  const m = UNIQUE_RE.exec(raw);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/** The leading four digits of a cadastral number name the cadastral area. */
export function cadastralAreaCode(normalizedCadastral: string): string {
  return normalizedCadastral.slice(0, 4);
}

export type ParcelIds = {
  /** Normalised `NNNN/NNNN:NNNN`, sorted. */
  cadastrals: string[];
  /** Normalised 12-digit unique numbers, sorted. */
  uniqueNumbers: string[];
};

/**
 * Every parcel identifier in a chunk of text, de-duplicated and sorted.
 *
 * Sorting matters beyond tidiness: the synthetic event id is derived from this
 * list, and these pages list parcels in no consistent order, so an
 * order-dependent id would change from run to run for an unchanged notice.
 */
export function extractParcelIds(text: string): ParcelIds {
  const cadastrals = new Set<string>();
  const uniqueNumbers = new Set<string>();

  for (const match of text.matchAll(globally(CADASTRAL_RE))) {
    const n = normalizeCadastral(match[0]);
    if (n) cadastrals.add(n);
  }
  for (const match of text.matchAll(globally(UNIQUE_RE))) {
    const n = normalizeUniqueNumber(match[0]);
    if (n) uniqueNumbers.add(n);
  }

  return {
    cadastrals: [...cadastrals].sort(),
    uniqueNumbers: [...uniqueNumbers].sort(),
  };
}

/** True when the text names at least one parcel, in either notation. */
export function hasParcelId(text: string): boolean {
  return CADASTRAL_RE.test(text) || UNIQUE_RE.test(text);
}
