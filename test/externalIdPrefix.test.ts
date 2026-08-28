import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalIdPrefixClause } from '../utils/externalIdPrefix';

describe('restricting a cleanup to one source', () => {
  it('matches ids that begin with the prefix', () => {
    assert.equal(
      externalIdPrefixClause('portal:zarasu_raj:'),
      "external_id LIKE 'portal:zarasu\\_raj:%' ESCAPE '\\'",
    );
  });

  it('escapes the underscore every municipality slug contains', () => {
    // `_` is LIKE's single-character wildcard. Unescaped, `portal:kauno_m:`
    // also matches `portal:kaunoXm:` — one municipality's cleanup retiring
    // another's events, which this clause is the only guard against.
    const clause = externalIdPrefixClause('portal:kauno_m:');
    assert.ok(clause.includes('kauno\\_m'), 'the underscore must be escaped');
    assert.ok(clause.endsWith("ESCAPE '\\'"), 'an escape character must be declared');
  });

  it('escapes the other wildcards too', () => {
    assert.ok(externalIdPrefixClause('a%b:').includes('a\\%b'));
    assert.ok(externalIdPrefixClause('a\\b:').includes('a\\\\b'));
  });

  it('escapes quotes so the clause cannot be broken out of', () => {
    assert.ok(externalIdPrefixClause("it's:").includes("it''s"));
  });
});
