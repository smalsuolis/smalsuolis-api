# Stats Hectares Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring back the "Leidimų skaičius / Kertamas plotas" toggle on the Kirtimų leidimai stats card, and make the "preliminary cleared area" estimate behind it compute a real number instead of a flat 25 % of everything.

**Architecture:** The API already returns `area` and `calculatedArea` per lumbering tag, so the toggle is a frontend-only restoration — except that `calculatedArea` is broken and must be fixed first. The broken weighting lives in a SQL `CASE` that switches on `tags_data[].name`, a field the lumbering integration always writes as the literal `'area'`; the cutting type it means to switch on is the _tag_, reachable in JS via `tagsById[tagId]`. The fix moves the weighting out of SQL into a pure `lumberingIntensity()` util, which is unit-testable. On the web, the row-building logic is extracted into a pure util (the repo has vitest but no React Testing Library, so pure functions are the only testable layer) and `BreakdownCard` gains three optional props so the other four cards render byte-identically.

**Tech Stack:** smalsuolis-api — Moleculer.js + Knex + Postgres, tests via `node:test`. smalsuolis-web — React + TypeScript + styled-components + @tanstack/react-query, tests via vitest.

**Spec:** this document's "Context" and "Acceptance checklist" sections (decisions taken 2026-09-22; the prior art is smalsuolis-web `b91b2e6` and `acaeb36`).

## Context

The March 2026 stats page had a two-pill switch in the Kirtimų leidimai card header:

- `b91b2e6` (2026-03-17) "Stats page - sum chop permit / chop area" — the **Leidimų skaičius / Kertamas plotas** switch
- `acaeb36` (2026-03-20) "stats page estimated chop area" — a "Preliminarus iškirstas plotas pagal kirtimo intensyvumą" line with an info tooltip

Both were lost in the `b25d828` redesign, which replaced the hand-rolled stats markup with `BreakdownCard`.

**The bug.** `calculatedArea` is supposed to weight each permit's area by how much of the stand a cut of that kind actually clears (clear cut 100 %, shelterwood 50 %, everything else 25 %). Verified against the live API (`GET /api/stats`, 2026-01-01 → 2026-09-22): all 20 cutting types come back at a ratio of **exactly 0.25**, total 128 625,77 ha → 32 156,44 ha. The cause:

- `services/integrations.lumbering.service.ts:208-214` writes every `tagsData` entry as `{ id, name: 'area', value }` — `name` is the _measure_, not the cutting type.
- `services/events.service.ts:322-333` switches on `elem.tag_name IN ('Plynas', 'Plynas sanitarinis', 'Lydimo')` / `'Atvejiniai'`, which never matches `'area'`, so every row falls to `ELSE … * 0.25`.
- The names in that `CASE` do not exist in the data either. The real tag names are `Plynas kirtimas`, `Plynas sanitarinis kirtimas`, `Miško lydimo kirtimas`, `Atvejinis kirtimas`, …

**Decisions taken:**

1. The toggle lives **in the Kirtimų leidimai card only** — it is the only source carrying hectares. The other four cards keep rendering exactly as they do now.
2. `calculatedArea` is **fixed and shown**, not dropped and not shipped as-is.

## Global Constraints

- `strict: true` TypeScript in both repos. No `any` — an unknown shape is `unknown` and gets narrowed.
- All identifiers, comments and docs in English. All user-facing copy in Lithuanian.
- Numbers are formatted with `toLocaleString('lt-LT')`; hectares carry 2 decimals and a ` ha` suffix.
- The API response shape stays backwards compatible: `byApp.miskoKirtimai.byTag[name]` keeps `count`, `area` and `calculatedArea` with the same meanings (`area` = declared felling area in ha, `calculatedArea` = intensity-weighted estimate in ha).
- Intensity weights, as the March tooltip defined them and mapped onto the tag names that actually exist:
  - **100 %** — names starting with `Plynas` (`Plynas kirtimas`, `Plynas sanitarinis kirtimas`, `Plynas sanitarinis kirtimas (stich. nelaim. atv.)`) and `Miško lydimo`
  - **50 %** — names starting with `Atvejinis`, `Atvejinių` or `Supaprastintas atvejinis`
  - **25 %** — everything else
- Matching is by **prefix**, never by substring: `Kiti specialieji miško kirtimai (Bt, D, Gl, Bl kirtimas neplynaisiais kirtimais)` contains "plynais" and must stay at 25 %.

## File Structure

**smalsuolis-api**

| File                                                    | Responsibility                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `utils/lumberingIntensity.ts` (create)                  | Pure map from a cutting-type tag name to the share of the permitted area it clears.                                     |
| `test/lumberingIntensity.test.ts` (create)              | Pins every tag name currently in the data, plus the "neplynaisiais" trap.                                               |
| `services/events.service.ts` (modify: 310-345, 416-435) | Drops the dead SQL `CASE`, sums raw hectares per tag id, applies the intensity in JS where the tag is already resolved. |

**smalsuolis-web**

| File                                                       | Responsibility                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/statsRows.ts` (create)                          | Pure row building + value formatting for a breakdown card, metric-aware.                                                   |
| `src/utils/statsRows.test.ts` (create)                     | Unit tests for both.                                                                                                       |
| `src/utils/types.ts` (modify: 306-309)                     | `miskoKirtimai.byTag` gains `calculatedArea`.                                                                              |
| `src/components/stats/MetricToggle.tsx` (create)           | The two-pill segmented control.                                                                                            |
| `src/components/stats/BreakdownCard.tsx` (modify)          | Three optional props — `formatValue`, `toolbar`, `footer` — plus a delta suffix. Defaults keep every other card unchanged. |
| `src/pages/Stats.tsx` (modify: 129-141, 166-172, ~307-327) | Holds the metric state, wires the toggle, the formatter and the estimate footer.                                           |

---

### Task 1: The intensity util (smalsuolis-api)

**Files:**

- Create: `/home/lukas/Desktop/smalsuolis-api/utils/lumberingIntensity.ts`
- Test: `/home/lukas/Desktop/smalsuolis-api/test/lumberingIntensity.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `lumberingIntensity(tagName: string): number` — returns `1`, `0.5` or `0.25`.

- [ ] **Step 1: Write the failing test**

Create `test/lumberingIntensity.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lumberingIntensity } from '../utils/lumberingIntensity';

describe('how much of a permitted stand a cut actually clears', () => {
  it('takes the whole stand for a clear cut', () => {
    assert.equal(lumberingIntensity('Plynas kirtimas'), 1);
    assert.equal(lumberingIntensity('Plynas sanitarinis kirtimas'), 1);
    assert.equal(lumberingIntensity('Plynas sanitarinis kirtimas (stich. nelaim. atv.)'), 1);
    assert.equal(lumberingIntensity('Miško lydimo kirtimas'), 1);
  });

  it('takes half for a shelterwood cut', () => {
    assert.equal(lumberingIntensity('Atvejinis kirtimas'), 0.5);
    assert.equal(lumberingIntensity('Atvejinių miško kirtimų paskutinis atvejis'), 0.5);
    assert.equal(lumberingIntensity('Supaprastintas atvejinis kirtimas (Labanausko)'), 0.5);
  });

  it('takes a quarter for every thinning and tending cut', () => {
    for (const name of [
      'Atrankinis kirtimas',
      'Atrankinis sanitarinis kirtimas',
      'Jaunuolynų ugdymas',
      'Einamasis kirtimas',
      'Retinimas',
      'Kiti specialieji miško kirtimai (savo reikmėms)',
      'Kiti specialieji miško kirtimai (tarp. naud.)',
      'Kiti specialieji miško kirtimai (pagr. naud.)',
      'Medynų ir krūmynų pertvarkymo kirtimas',
      'Ribinių linijų kirtimas',
      'Biologinės įvairovės palaikymo miško kirtimas',
      'Kraštovaizdžio formavimo miško kirtimas',
    ]) {
      assert.equal(lumberingIntensity(name), 0.25, name);
    }
  });

  // The one name that breaks substring matching: it contains "plynais", so an
  // `includes('Plynas')`-style rule would hand a thinning cut a 100 % weight.
  it('does not mistake a cut named "neplynaisiais" for a clear cut', () => {
    assert.equal(
      lumberingIntensity(
        'Kiti specialieji miško kirtimai (Bt, D, Gl, Bl kirtimas neplynaisiais kirtimais)',
      ),
      0.25,
    );
  });

  it('falls back to a quarter for a name the feed has not used before', () => {
    assert.equal(lumberingIntensity('Visiškai naujas kirtimo tipas'), 0.25);
    assert.equal(lumberingIntensity(''), 0.25);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /home/lukas/Desktop/smalsuolis-api && node --require ts-node/register --test test/lumberingIntensity.test.ts
```

Expected: FAIL — `Cannot find module '../utils/lumberingIntensity'`.

- [ ] **Step 3: Write the implementation**

Create `utils/lumberingIntensity.ts`:

```ts
// A felling permit states the area of the stand it covers, not how much of that
// stand comes down: a clear cut takes all of it, a shelterwood cut roughly half,
// a thinning or tending cut about a quarter. These shares turn the declared area
// into an estimate of the area actually cleared.
//
// Matched by PREFIX, never by substring — "Kiti specialieji miško kirtimai (Bt,
// D, Gl, Bl kirtimas neplynaisiais kirtimais)" contains "plynais" and is a
// quarter-intensity cut.
const INTENSITY_BY_PREFIX: Array<[prefix: string, share: number]> = [
  ['Plynas', 1],
  ['Miško lydimo', 1],
  ['Atvejinis', 0.5],
  ['Atvejinių', 0.5],
  ['Supaprastintas atvejinis', 0.5],
];

const DEFAULT_INTENSITY = 0.25;

export const lumberingIntensity = (tagName: string): number => {
  const name = (tagName || '').trim();
  const match = INTENSITY_BY_PREFIX.find(([prefix]) => name.startsWith(prefix));
  return match ? match[1] : DEFAULT_INTENSITY;
};
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd /home/lukas/Desktop/smalsuolis-api && node --require ts-node/register --test test/lumberingIntensity.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/lukas/Desktop/smalsuolis-api
git add utils/lumberingIntensity.ts test/lumberingIntensity.test.ts
git commit -m "feat(stats): name how much of a stand each kind of cut clears"
```

---

### Task 2: Apply the intensity where the tag is known (smalsuolis-api)

**Files:**

- Modify: `/home/lukas/Desktop/smalsuolis-api/services/events.service.ts:310-345` (the `eventsCountByTagData` query) and `:416-435` (the `forEach` that folds it into `stats`)

**Interfaces:**

- Consumes: `lumberingIntensity(tagName: string): number` from Task 1.
- Produces: unchanged response shape — `stats.byApp[appType].byTag[tagName]` carries `count` (permits, set elsewhere), `area` (declared ha) and `calculatedArea` (weighted ha).

- [ ] **Step 1: Replace the query**

Delete the whole `const eventsCountByTagData = await knex…` block (lines 310-345) and put this in its place. The nested `CASE` goes away entirely: the weighting no longer happens in SQL, so the subquery only has to sum the declared hectares per tag id.

```ts
// Declared felling area per tag. `tags_data[].value` is the `kertamas_plotas`
// the lumbering feed gives in hectares; `name` there is always the literal
// 'area' (the measure), so the cutting type has to come from the tag itself —
// see the forEach below, where tagsById resolves it.
const eventsAreaByTagId = await knex
  .select(knex.raw('elem.tag_id::numeric as tag_id'))
  .sum({
    areaHa: knex.raw("(NULLIF(regexp_replace(elem.tag_value, '[^0-9.]', '', 'g'), ''))::numeric"),
  })
  .from(
    knex
      .select(
        knex.raw(`jsonb_array_elements(events.tags_data)->>'id' as tag_id`),
        knex.raw(`jsonb_array_elements(events.tags_data)->>'value' as tag_value`),
      )
      .from(eventsQuery.as('events'))
      .whereNotNull('events.tagsData')
      .as('elem'),
  )
  .groupBy('tagId');
```

- [ ] **Step 2: Replace the fold**

Delete the `eventsCountByTagData?.forEach(…)` block (lines 416-435) and put this in its place:

```ts
eventsAreaByTagId?.forEach((item) => {
  const tag = tagsById[item.tagId];
  if (!tag) return;

  const areaHa = Number(item.areaHa || 0);
  const basePath = ['byApp', tag.appType, 'byTag', tag.name];
  const areaPath = [...basePath, 'area'];
  const calculatedAreaPath = [...basePath, 'calculatedArea'];

  _.set(stats, areaPath, _.get(stats, areaPath, 0) + areaHa);
  _.set(
    stats,
    calculatedAreaPath,
    _.get(stats, calculatedAreaPath, 0) + areaHa * lumberingIntensity(tag.name),
  );
});
```

- [ ] **Step 3: Add the import**

At the top of `services/events.service.ts`, next to the other local imports:

```ts
import { lumberingIntensity } from '../utils/lumberingIntensity';
```

- [ ] **Step 4: Typecheck and lint**

```bash
cd /home/lukas/Desktop/smalsuolis-api && yarn build && yarn lint
```

Expected: no errors. If `yarn build` complains about an unused `tagsById` binding elsewhere, leave that binding alone — it is used by `eventsCountByTagId` too.

- [ ] **Step 5: Verify against real data**

Bring the API up against a database that has lumbering events:

```bash
cd /home/lukas/Desktop/smalsuolis-api && yarn dc:up   # or `yarn dev` against an existing DB
curl -s 'http://localhost:3000/stats?query=%7B%22startAt%22%3A%7B%22%24gte%22%3A%222026-01-01%22%2C%22%24lt%22%3A%222026-09-22%22%7D%7D' \
  | python3 -c "
import json,sys
mk=json.load(sys.stdin)['byApp']['miskoKirtimai']['byTag']
for k,v in sorted(mk.items(), key=lambda kv:-kv[1]['count']):
    a,ca=v.get('area',0),v.get('calculatedArea',0)
    print(f'{k:65s} ha={a:10.2f} calc={ca:10.2f} ratio={round(ca/a,3) if a else None}')
"
```

Expected: `Plynas kirtimas` and `Miško lydimo kirtimas` at ratio `1.0`, `Atvejinis kirtimas` at `0.5`, `Jaunuolynų ugdymas` and `Kiti specialieji miško kirtimai (… neplynaisiais kirtimais)` at `0.25`. Before this change every single ratio was `0.25` — that is the regression being fixed, so a run where they are all still `0.25` means the change did not take.

If no local database is available, this step moves to a post-deploy check against `https://smalsuolis.lt/api/stats` with the same query — but it must be run, not skipped: Task 5's acceptance depends on it.

- [ ] **Step 6: Run the full API test suite**

```bash
cd /home/lukas/Desktop/smalsuolis-api && yarn test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/lukas/Desktop/smalsuolis-api
git add services/events.service.ts
git commit -m "fix(stats): weight the cleared area by the cut, not by a field that never matched"
```

---

### Task 3: Metric-aware row building (smalsuolis-web)

**Files:**

- Create: `/home/lukas/Desktop/smalsuolis-web/src/utils/statsRows.ts`
- Test: `/home/lukas/Desktop/smalsuolis-web/src/utils/statsRows.test.ts`
- Modify: `/home/lukas/Desktop/smalsuolis-web/src/utils/types.ts:306-309`

**Interfaces:**

- Consumes: `BreakdownRow` from `src/components/stats/BreakdownCard` (`{ label: string; count: number; previousCount?: number; total: number }`).
- Produces:

  - `type StatMetric = 'count' | 'area'`
  - `buildTagRows(tagMap: TagStats | undefined, prevMap: TagStats | undefined, metric: StatMetric): BreakdownRow[]`
  - `formatStatValue(value: number, metric: StatMetric): string`
  - `type TagStats = Record<string, { count: number; area?: number; calculatedArea?: number }>`

- [ ] **Step 1: Widen the API type**

In `src/utils/types.ts`, replace lines 306-309:

```ts
    miskoKirtimai: {
      count: number;
      byTag: Record<string, { count: number; area: number }>;
    };
```

with:

```ts
    miskoKirtimai: {
      count: number;
      // `area` is the felling area the permits declare, in hectares.
      // `calculatedArea` weights it by how much of the stand each kind of cut
      // actually clears — see lumberingIntensity in the API.
      byTag: Record<string, { count: number; area: number; calculatedArea: number }>;
    };
```

- [ ] **Step 2: Write the failing test**

Create `src/utils/statsRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTagRows, formatStatValue } from './statsRows';

const TAGS = {
  'Plynas kirtimas': { count: 10, area: 40.5, calculatedArea: 40.5 },
  Retinimas: { count: 30, area: 8, calculatedArea: 2 },
};

const PREV = {
  'Plynas kirtimas': { count: 4, area: 30.5, calculatedArea: 30.5 },
  Retinimas: { count: 30, area: 8, calculatedArea: 2 },
};

describe('buildTagRows', () => {
  it('counts permits and sorts by the count', () => {
    const rows = buildTagRows(TAGS, undefined, 'count');
    expect(rows.map((r) => r.label)).toEqual(['Retinimas', 'Plynas kirtimas']);
    expect(rows[0].count).toBe(30);
    expect(rows[0].total).toBe(40);
  });

  // The two metrics do not rank the same: Retinimas issues three times the
  // permits of Plynas kirtimas over a fifth of the area.
  it('sums hectares and re-sorts by the area', () => {
    const rows = buildTagRows(TAGS, undefined, 'area');
    expect(rows.map((r) => r.label)).toEqual(['Plynas kirtimas', 'Retinimas']);
    expect(rows[0].count).toBe(40.5);
    expect(rows[0].total).toBe(48.5);
  });

  it('carries the previous period in the metric being shown', () => {
    expect(buildTagRows(TAGS, PREV, 'count')[1].previousCount).toBe(4);
    expect(buildTagRows(TAGS, PREV, 'area')[0].previousCount).toBe(30.5);
  });

  it('treats a tag with no hectares as zero rather than dropping it', () => {
    const rows = buildTagRows({ 'Be ploto': { count: 5 } }, undefined, 'area');
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(0);
  });

  it('returns nothing when there is no data', () => {
    expect(buildTagRows(undefined, undefined, 'count')).toEqual([]);
  });
});

describe('formatStatValue', () => {
  it('writes a count as a plain grouped number', () => {
    expect(formatStatValue(59211, 'count')).toBe('59 211');
  });

  it('writes an area with two decimals and a unit', () => {
    expect(formatStatValue(128625.766, 'area')).toBe('128 625,77 ha');
  });
});
```

Note: `toLocaleString('lt-LT')` groups with a non-breaking space (U+00A0). If the assertions above fail on the separator alone, fix the _test_ to use `'59 211'` / `'128 625,77 ha'` — not the implementation.

- [ ] **Step 3: Run the test and verify it fails**

```bash
cd /home/lukas/Desktop/smalsuolis-web && yarn vitest run src/utils/statsRows.test.ts
```

Expected: FAIL — cannot resolve `./statsRows`.

- [ ] **Step 4: Write the implementation**

Create `src/utils/statsRows.ts`:

```ts
import { orderBy } from 'lodash';
import type { BreakdownRow } from '../components/stats/BreakdownCard';

// What a breakdown card is counting. Only miskoKirtimai carries hectares, so
// only that card ever switches; every other card stays on 'count'.
export type StatMetric = 'count' | 'area';

export type TagStats = Record<string, { count: number; area?: number; calculatedArea?: number }>;

const pick = (stat: { count: number; area?: number } | undefined, metric: StatMetric) =>
  metric === 'area' ? stat?.area ?? 0 : stat?.count ?? 0;

// Rows for one breakdown card, in the chosen metric: the value carried in
// `count`, the same metric's previous-period value for the delta, and the
// column's own total as the denominator for the % share.
export const buildTagRows = (
  tagMap: TagStats | undefined,
  prevMap: TagStats | undefined,
  metric: StatMetric,
): BreakdownRow[] => {
  if (!tagMap) return [];

  const total = Object.values(tagMap).reduce((sum, stat) => sum + pick(stat, metric), 0);
  const rows = Object.entries(tagMap).map(([label, stat]) => ({
    label,
    count: pick(stat, metric),
    previousCount: prevMap?.[label] ? pick(prevMap[label], metric) : undefined,
    total,
  }));

  return orderBy(rows, (row) => row.count, 'desc');
};

export const formatStatValue = (value: number, metric: StatMetric): string =>
  metric === 'area'
    ? `${value.toLocaleString('lt-LT', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ha`
    : value.toLocaleString('lt-LT');
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
cd /home/lukas/Desktop/smalsuolis-web && yarn vitest run src/utils/statsRows.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
cd /home/lukas/Desktop/smalsuolis-web
git add src/utils/statsRows.ts src/utils/statsRows.test.ts src/utils/types.ts
git commit -m "feat(stats): build breakdown rows in either permits or hectares"
```

---

### Task 4: Let a breakdown card carry a unit, a toolbar and a footer (smalsuolis-web)

**Files:**

- Create: `/home/lukas/Desktop/smalsuolis-web/src/components/stats/MetricToggle.tsx`
- Modify: `/home/lukas/Desktop/smalsuolis-web/src/components/stats/BreakdownCard.tsx`

**Interfaces:**

- Consumes: `StatMetric` from `src/utils/statsRows`; `Card`, `CardHeader`, `CardTotal`, `StatRow` etc. from `./cardStyles`.
- Produces:

  - `MetricToggle({ value, onChange }: { value: StatMetric; onChange: (m: StatMetric) => void })`
  - `BreakdownCard` gains four optional props: `formatValue?: (value: number) => string`, `deltaSuffix?: string`, `toolbar?: ReactNode`, `footer?: ReactNode`. Every existing call site keeps working untouched.

- [ ] **Step 1: Write the toggle**

Create `src/components/stats/MetricToggle.tsx`:

```tsx
import styled from 'styled-components';
import type { StatMetric } from '../../utils/statsRows';

const OPTIONS: Array<{ value: StatMetric; label: string }> = [
  { value: 'count', label: 'Leidimų skaičius' },
  { value: 'area', label: 'Kertamas plotas' },
];

// Two pills, one of them filled — the same switch the March stats page had,
// redrawn against the card's own outline so it sits inside a BreakdownCard.
const MetricToggle = ({
  value,
  onChange,
}: {
  value: StatMetric;
  onChange: (metric: StatMetric) => void;
}) => (
  <Track role="group" aria-label="Rodiklis">
    {OPTIONS.map((option) => (
      <Pill
        key={option.value}
        type="button"
        $isActive={value === option.value}
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </Pill>
    ))}
  </Track>
);

export default MetricToggle;

const Track = styled.div`
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid ${({ theme }) => theme.colors.grey[300]};
  border-radius: 999px;
  align-self: flex-start;
  max-width: 100%;
`;

const Pill = styled.button<{ $isActive: boolean }>`
  padding: 6px 12px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  font-size: 1.3rem;
  line-height: 1.8rem;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
  background: ${({ $isActive, theme }) => ($isActive ? theme.colors.primary : 'transparent')};
  color: ${({ $isActive, theme }) => ($isActive ? theme.colors.white : theme.colors.text.primary)};
`;
```

If `theme.colors.primary` reads too dark for white text, use `theme.colors.text.primary` as the background instead — check against the neighbouring `ToggleSwitch` in `src/pages/Stats.tsx:607-625`, which is the page's existing precedent.

- [ ] **Step 2: Extend BreakdownCard**

In `src/components/stats/BreakdownCard.tsx`:

Add `import { ReactNode, useState } from 'react';` (replacing the existing `useState` import), then extend the props and the body. The full replacement for the component signature and its render:

```tsx
const BreakdownCard = ({
  icon,
  iconBg,
  title,
  total,
  rows,
  showComparison,
  isFetching,
  initialVisible = 5,
  formatValue = (value: number) => value.toLocaleString('lt-LT'),
  deltaSuffix,
  toolbar,
  footer,
}: {
  icon: string;
  iconBg: string;
  title: string;
  total: number;
  rows: BreakdownRow[];
  showComparison?: boolean;
  isFetching?: boolean;
  initialVisible?: number;
  // How a row value and the card total are written. Defaults to a plain grouped
  // number, which is what every card but Kirtimai uses.
  formatValue?: (value: number) => string;
  deltaSuffix?: string;
  // Rendered between the header and the rows — the metric switch.
  toolbar?: ReactNode;
  // Rendered under the rows, above the Rodyti daugiau button.
  footer?: ReactNode;
}) => {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, initialVisible);

  return (
    <Card>
      <CardHeader>
        <TitleGroup>
          <IconCircle $bg={iconBg}>
            <CircleIcon src={icon} alt="" />
          </IconCircle>
          <CardHeading>{title}</CardHeading>
        </TitleGroup>
        <CardTotal as="div">{formatValue(total)}</CardTotal>
      </CardHeader>

      {toolbar}

      <RowList>
        {rows.length === 0 && <EmptyRow>Šiuo laikotarpiu įvykių nėra</EmptyRow>}
        {visible.map((r) => {
          const pct = r.total > 0 ? (r.count * 100) / r.total : 0;
          return (
            <Row key={r.label}>
              <RowLabel>{r.label}</RowLabel>
              <RowValues>
                <Percent>{pct.toFixed(1)}%</Percent>
                <RowCount>
                  {formatValue(r.count)}
                  {showComparison && (
                    <Delta
                      current={r.count}
                      previous={r.previousCount}
                      isFetching={isFetching}
                      suffix={deltaSuffix}
                    />
                  )}
                </RowCount>
              </RowValues>
            </Row>
          );
        })}
      </RowList>

      {footer}

      {rows.length > initialVisible && (
        <MoreButton onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Rodyti mažiau' : 'Rodyti daugiau'}
        </MoreButton>
      )}
    </Card>
  );
};
```

`Delta`'s `suffix` prop already defaults to `''`, so passing `undefined` is a no-op — the other cards are untouched.

- [ ] **Step 3: Typecheck and lint**

```bash
cd /home/lukas/Desktop/smalsuolis-web && yarn build && yarn lint
```

Expected: no errors. `Stats.tsx` still compiles because all four new props are optional.

- [ ] **Step 4: Commit**

```bash
cd /home/lukas/Desktop/smalsuolis-web
git add src/components/stats/MetricToggle.tsx src/components/stats/BreakdownCard.tsx
git commit -m "feat(stats): a breakdown card can carry a unit, a switch and a footnote"
```

---

### Task 5: Wire the toggle into the Kirtimai card (smalsuolis-web)

**Files:**

- Modify: `/home/lukas/Desktop/smalsuolis-web/src/pages/Stats.tsx` — the `tagRows` helper (129-141), the `breakdownCards` array (166-172) and the card grid render (~307-327)

**Interfaces:**

- Consumes: `buildTagRows`, `formatStatValue`, `StatMetric` (Task 3); `MetricToggle` and the extended `BreakdownCard` (Task 4).
- Produces: nothing downstream.

- [ ] **Step 1: Swap the local helper for the tested one**

Replace the inline `tagRows` (lines 129-141) with a thin wrapper that carries the metric, and delete the now-dead body:

```ts
// ---- "Suskirstymas pagal tipą" cards ---------------------------------
// Only Kirtimai has hectares to switch to; every other card stays on counts.
const [kirtimaiMetric, setKirtimaiMetric] = useState<StatMetric>('count');

const tagRows = (tagMap?: TagStats, prevMap?: TagStats, metric: StatMetric = 'count') =>
  buildTagRows(tagMap, prevMap, metric);
```

Add to the imports at the top of the file:

```ts
import MetricToggle from '../components/stats/MetricToggle';
import Tooltip from '../components/Tooltip';
import Icon from '../components/Icons';
import { IconName } from '../utils/constants';
import { buildTagRows, formatStatValue, type StatMetric, type TagStats } from '../utils/statsRows';
```

Check how `Icon` is exported from `src/components/Icons.tsx` before writing the import — if it is a named export, adjust accordingly.

The `orderBy` import from lodash stays: `municipalityRows` and `topCities` still use it.

- [ ] **Step 2: Feed the metric into the Kirtimai card entry**

In the `breakdownCards` array, replace the `miskoKirtimai` entry:

```ts
    {
      app: 'miskoKirtimai',
      title: 'Kirtimų leidimai',
      rows: tagRows(
        byApp?.miskoKirtimai?.byTag,
        prevByApp?.miskoKirtimai?.byTag,
        kirtimaiMetric,
      ),
      metric: kirtimaiMetric,
      // In hectares the header total is the sum of the rows, not the permit
      // count — and it only covers permits that declared an area, so a permit
      // with no `kertamas_plotas` adds a row's worth of nothing, as it should.
      total:
        kirtimaiMetric === 'area'
          ? Object.values(byApp?.miskoKirtimai?.byTag ?? {}).reduce(
              (sum, stat) => sum + (stat.area || 0),
              0,
            )
          : byApp?.miskoKirtimai?.count || 0,
      estimatedArea: Object.values(byApp?.miskoKirtimai?.byTag ?? {}).reduce(
        (sum, stat) => sum + (stat.calculatedArea || 0),
        0,
      ),
    },
```

Leave the other four entries exactly as they are — they have no `metric` and no `estimatedArea`, so they fall through to the defaults.

- [ ] **Step 3: Render the toggle and the estimate**

In the card grid, replace the `<BreakdownCard … />` call:

```tsx
{
  breakdownCards.map((c) => {
    // Tags when the source has them, municipalities when it does not —
    // the rows name themselves ("Vilniaus r. sav."), so nothing has to
    // announce which cut this is.
    const rows = c.rows.length ? c.rows : c.fallbackRows?.() ?? [];
    const metric: StatMetric = c.metric ?? 'count';
    return (
      <BreakdownCard
        key={c.title}
        icon={APP_BADGE[c.app].icon}
        iconBg={APP_BADGE[c.app].bg}
        title={c.title}
        total={c.total}
        rows={rows}
        showComparison={isComparisonEnabled}
        isFetching={isPreviousFetching}
        formatValue={(value) => formatStatValue(value, metric)}
        deltaSuffix={metric === 'area' ? ' ha' : undefined}
        toolbar={
          c.metric ? <MetricToggle value={metric} onChange={setKirtimaiMetric} /> : undefined
        }
        footer={
          metric === 'area' ? (
            <EstimateRow>
              <EstimateLabel>Preliminarus iškirstas plotas pagal kirtimo intensyvumą</EstimateLabel>
              <EstimateValue>
                {formatStatValue(c.estimatedArea ?? 0, 'area')}
                <Tooltip
                  content={
                    <div>
                      Apskaičiuojama pagal kirtimo leidimų tipus ir jiems priskirtą procentinę dalį
                      nuo numatomo ploto.
                      <br />
                      <br />
                      Plyni ir miško lydimo kirtimai – 100%
                      <br />
                      Atvejiniai kirtimai – 50%
                      <br />
                      Kiti kirtimai – 25%
                    </div>
                  }
                >
                  <Icon name={IconName.info} />
                </Tooltip>
              </EstimateValue>
            </EstimateRow>
          ) : undefined
        }
      />
    );
  });
}
```

Add the three styled components next to the page's other ones (near `ToggleLabel`, ~line 602):

```ts
const EstimateRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  font-size: 1.4rem;
  line-height: 2.1rem;
  color: ${({ theme }) => theme.colors.grey[600]};
`;

const EstimateLabel = styled.span`
  min-width: 0;
`;

const EstimateValue = styled.span`
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 700;
`;
```

- [ ] **Step 4: Typecheck, lint and the web suite**

```bash
cd /home/lukas/Desktop/smalsuolis-web && yarn build && yarn lint && yarn test
```

Expected: all green.

- [ ] **Step 5: Verify live in the browser**

```bash
cd /home/lukas/Desktop/smalsuolis-web && yarn start
```

Open `/statistika` and walk the acceptance checklist below, item by item, at 1440px and at 375×812. Keep the devtools console open — 0 errors is part of passing.

- [ ] **Step 6: Commit**

```bash
cd /home/lukas/Desktop/smalsuolis-web
git add src/pages/Stats.tsx
git commit -m "feat(stats): the kirtimai card counts hectares as well as permits"
```

---

## Acceptance checklist

Walk each item against the running app, not against the code.

- [ ] The Kirtimų leidimai card shows a **Leidimų skaičius / Kertamas plotas** switch; `Leidimų skaičius` is selected on load.
- [ ] The other four cards (Statybų leidimai, Žemėtvarkos planavimas, Žuvinimas, Žemės paskirties keitimas) render exactly as before — no switch, no footnote, counts unchanged.
- [ ] Switching to **Kertamas plotas** changes the card total to hectares (for 2026-01-01 → 2026-09-22 that is `128 625,77 ha`), and every row reads as `… ha` with two decimals.
- [ ] The rows **re-sort** on the switch: `Atrankinis sanitarinis kirtimas` leads by area, `Plynas kirtimas` leads by permit count.
- [ ] The `%` column is a share of the hectare total, and the visible shares sum toward 100 % (not toward the permit-count shares).
- [ ] With **Lyginti su ankstesniu periodu** on, deltas in area mode are hectares (`+12,4 ha`), not permit counts.
- [ ] Under the rows: **Preliminarus iškirstas plotas pagal kirtimo intensyvumą** with a number and an info icon; the tooltip opens on hover and on tap, and names the real cut groups (plyni / miško lydimo — 100 %, atvejiniai — 50 %, kiti — 25 %).
- [ ] That estimate is **not** the total × 0,25 any more. Cross-check against the API: for 2026 it should land well above the old `32 156,44 ha`, since plyni and lydimo cuts now count fully.
- [ ] `Rodyti daugiau` / `Rodyti mažiau` still expands and collapses in both metrics.
- [ ] At 375×812 the switch and the footnote wrap instead of widening the card; no horizontal page scroll.
- [ ] 0 console errors across the whole walk-through.
- [ ] `yarn build && yarn lint && yarn test` green in **both** repos.

## Deployment note

Task 5's frontend is useless until Task 2's API is deployed — `calculatedArea` stays at ×0,25 until then, and the footnote would publish a wrong number. **Ship the API first**, confirm the ratios against `https://smalsuolis.lt/api/stats`, then ship the web.

The stats endpoint caches responses for 6 hours in process memory (`STATS_CACHE_TTL_MS`, `services/events.service.ts:235`). After the API deploy, either wait out the TTL or pass `noCache=true` when verifying, or the old flat-25 % numbers will look like the fix failed.
