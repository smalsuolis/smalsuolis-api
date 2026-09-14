/**
 * Restricting a cleanup to one source's own events.
 *
 * Several integrations now feed a single app, and each run only knows the
 * externalIds it collected itself. This clause is the only thing keeping one
 * source's cleanup off another's events, so it has to match exactly what it
 * says and nothing more.
 */

/**
 * A `LIKE` clause matching every externalId that begins with `prefix`.
 *
 * Three things are escaped, not just the quote:
 *
 * - `_` is LIKE's single-character wildcard, and every municipality slug
 *   contains one. Unescaped, `portal:kauno_m:` also matches `portal:kaunoXm:`,
 *   so one municipality's cleanup could retire another's events.
 * - `%` is the multi-character wildcard, for the same reason.
 * - `\` is the escape character itself, so a literal backslash cannot smuggle
 *   in an escape sequence.
 *
 * The column is snake_case in Postgres — the codebase writes camelCase in JS
 * and relies on `knexSnakeCaseMappers`, which does not reach into raw SQL.
 */
export function externalIdPrefixClause(prefix: string): string {
  const escaped = prefix.replace(/'/g, "''").replace(/([\\%_])/g, '\\$1');
  return `external_id LIKE '${escaped}%' ESCAPE '\\'`;
}
