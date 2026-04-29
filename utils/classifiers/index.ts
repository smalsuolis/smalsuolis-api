import type { ClassifierSpec, Classifier, ClassifyInput } from './types';

export type { ClassifierSpec, ClassifyInput } from './types';

const specs = new Map<string, ClassifierSpec>();
const compiled = new Map<string, Classifier>();

export function registerClassifier(spec: ClassifierSpec) {
  validateSpec(spec);
  const rewritten = rewriteSpecPatterns(spec);
  specs.set(spec.appType, rewritten);
  compiled.set(spec.appType, buildClassifier(rewritten));
}

// JS `\b` only recognizes ASCII word characters even with the `u` flag,
// so patterns like /\b(šiltnami)/iu fail to match "Šiltnamis" at position 0
// (both sides of the boundary are non-ASCII-word). The Postgres POSIX
// regex flavor in the source spec doesn't have this problem.
//
// We rewrite each pattern at registration time, replacing \b with a
// Unicode-aware boundary built from \p{L}/\p{N} lookarounds. The 'u' flag
// is added if missing — required for the property escapes to work.
const UNICODE_BOUNDARY =
  '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';

function unicodeBoundaryAware(re: RegExp): RegExp {
  if (!re.source.includes('\\b')) {
    return re.flags.includes('u') ? re : new RegExp(re.source, re.flags + 'u');
  }
  const source = re.source.replace(/\\b/g, UNICODE_BOUNDARY);
  const flags = re.flags.includes('u') ? re.flags : re.flags + 'u';
  return new RegExp(source, flags);
}

function rewriteSpecPatterns(spec: ClassifierSpec): ClassifierSpec {
  return {
    ...spec,
    rules: spec.rules.map((r) => ({ ...r, pattern: unicodeBoundaryAware(r.pattern) })),
    specialization: spec.specialization?.map((block) => ({
      ...block,
      rules: block.rules.map((r) => ({ ...r, pattern: unicodeBoundaryAware(r.pattern) })),
    })),
  };
}

export function getRegisteredSpecs(): ClassifierSpec[] {
  return [...specs.values()];
}

// Returns:
//  - null  → no classifier registered for this appType (don't stamp category)
//  - code  → matched rule, or defaultWhenNoMatch if nothing matched
export function classify(appType: string, input: ClassifyInput): string | null {
  const fn = compiled.get(appType);
  if (!fn) return null;
  return fn(input);
}

// Test seam — only use in tests.
export function _resetClassifiersForTests() {
  specs.clear();
  compiled.clear();
}

function buildClassifier(spec: ClassifierSpec): Classifier {
  return ({ name, body }) => {
    const nameStr = name ?? '';
    const bodyStr = body ?? '';

    let category = spec.defaultWhenNoMatch;
    for (const rule of spec.rules) {
      if (rule.pattern.test(nameStr)) {
        category = rule.category;
        break;
      }
    }

    if (!spec.specialization?.length) return category;

    for (const block of spec.specialization) {
      if (block.whenCategory !== category) continue;
      const field = block.matchField === 'body' ? bodyStr : nameStr;
      if (!field) continue;
      for (const rule of block.rules) {
        if (rule.pattern.test(field)) {
          category = rule.category;
          break;
        }
      }
    }

    return category;
  };
}

function validateSpec(spec: ClassifierSpec) {
  const tag = `[classifiers/${spec.appType}]`;
  const codes = new Set<string>();

  for (const cat of spec.categories) {
    if (codes.has(cat.code)) {
      throw new Error(`${tag} duplicate category code: ${cat.code}`);
    }
    codes.add(cat.code);
  }
  for (const cat of spec.categories) {
    if (cat.parent !== null && !codes.has(cat.parent)) {
      throw new Error(`${tag} category ${cat.code} parent ${cat.parent} does not exist`);
    }
  }
  if (!codes.has(spec.defaultWhenNoMatch)) {
    throw new Error(`${tag} defaultWhenNoMatch ${spec.defaultWhenNoMatch} not in categories`);
  }
  for (const rule of spec.rules) {
    if (!codes.has(rule.category)) {
      throw new Error(`${tag} rule references unknown category: ${rule.category}`);
    }
  }
  for (const block of spec.specialization ?? []) {
    if (!codes.has(block.whenCategory)) {
      throw new Error(`${tag} specialization whenCategory ${block.whenCategory} unknown`);
    }
    for (const rule of block.rules) {
      if (!codes.has(rule.category)) {
        throw new Error(`${tag} specialization rule references unknown: ${rule.category}`);
      }
    }
  }
}
