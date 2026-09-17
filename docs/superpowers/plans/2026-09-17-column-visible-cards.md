# Agent Hive — visible cards per column (the first N and a "show more"): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Hive column renders every card it holds; the entry column has 13+ today and grows with the board (#46). After this change a column can carry `visible?: number` in `hive.config.json`: the board shows the running cards plus the first stopped cards that fit under the cap, in board order, and a ghost `+N more` / `show less` toggle under them reveals or hides the rest (state per column, in memory, gone on reload). The header always reads `<name> · <N> cards · weight <W>` so "5 visible" never reads as "5 exist". Absent or `0` = no limit, so an existing config keeps behaving the same; only a column created in the setup editor starts at `5`, and the legacy proposal (`legacyColumns`) carries `visible: 5` because it is a new column in the user's eyes.

**Architecture:** Six source files, about 60 lines. `src/types.ts`: `Column.visible?`. `src/config.ts`: `parseColumn` reads `visible` with `requireInt` (absent stays absent, same shape as the `session` line), `legacyColumns` adds `visible: 5`. `src/ui/lib/setup-form.ts`: `ColumnDraft.visible: string`, `emptyColumn` starts at `'5'`, `columnDraft` reuses `numberField` (0 or absent → `''`), `columnFrom` reuses `limitFrom` (empty or `0` → key absent), `columnsProblem` accepts empty or an integer ≥ 0. `src/ui/i18n.ts`: `column.cards`, `column.weight`, `column.more`, `column.less`, `setup.columns.visible`, updated `setup.columns.error` and `setup.columns.hint`, en + pt. `src/ui/components/HiveBoard.tsx`: the column body moves into a `ColumnCards({ cards, column, state })` component with `useState(false)`; `running = cards.filter((c) => c.slotId)`, `room = Math.max(cap - running.length, 0)`, the collapsed set is running ∪ the first `room` stopped cards in array order, `hidden = cards.length - collapsed.length`, the toggle is a `Button variant="ghost" size="xs"` (both variants exist in `src/ui/components/ui/button.tsx` lines 18 and 24). `src/ui/components/setup/ColumnEditor.tsx`: one `Input type="number"` next to weight. `src/orchestrator.ts`, `src/server.ts`, `src/log.ts` (`describeColumns` keeps `name(weight)`) do not change: the cap is a display rule, never a scheduling one.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions on the Node side), Electron, Express 5, Vite + React + shadcn/ui for `src/ui`, `node:test` + `node:assert/strict` for everything framework-free (including `src/ui/i18n.ts` and `src/ui/lib/*`), vitest + jsdom + @testing-library/react for `test/ui/*.test.tsx`, Biome lint. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-column-visible-cards-design.md` (extends `2026-09-17-hive-columns-design.md` and `2026-09-17-react-ui-design.md` on top of `2026-09-15-agent-hive-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/46>. Plan file: `docs/superpowers/plans/2026-09-17-column-visible-cards.md`.

## Global Constraints

- All v1, setup, columns and React-UI constraints hold (immutable reducer, `execFile` argv arrays, every user-facing string goes through `t()` with en + pt entries in `src/ui/i18n.ts` — the UI is bilingual since #70 — code comments in English, conventional commits in English without `Co-Authored-By`, no machine-specific values).
- Only `src/types.ts`, `src/config.ts`, `src/ui/i18n.ts`, `src/ui/lib/setup-form.ts`, `src/ui/components/HiveBoard.tsx`, `src/ui/components/setup/ColumnEditor.tsx` and `README.md` change. `src/orchestrator.ts`, `src/server.ts`, `src/log.ts`, `src/boards/*`, `src/state-store.ts`, `src/ui/components/setup/BoardTab.tsx` (it already renders `setup.columns.hint` as HTML) do not change.
- Every decision in the spec's "Closed decisions" table is closed: the field is `visible?: number` on `Column`, for every column; absent or `0` = no limit; a new column in the editor starts at `5`; running cards always show and count against the cap; inline toggle under the cards, state per column in memory, no `localStorage`; header `${name} · ${t('column.cards', { n })} · ${t('column.weight', { w })}` with the count always shown; board order kept, only filtered.
- `parseColumn` is the trust boundary for the file: `visible` is validated with `requireInt` and the error names the index (`"columns[0].visible" must be a non-negative integer`); the UI never receives a `visible` the parser did not accept.
- `State`, `Card`, `Slot`, `HiveEvent`, `Effect`, `SetupBody` do not change; `Column` gains one optional field and `state.json` / `hive.config.json` pick it up for free (the whole column is persisted; absent keys stay absent so a file without limits stays clean).
- Files < 400 lines, functions < 50 lines (`ColumnCards` is one small component; `HiveBoard.tsx` ends around 100 lines), no new constants beyond `DEFAULT_VISIBLE` in `setup-form.ts`.
- Tests: `node:test` + `node:assert/strict` under `test/` (ESM, `.js` import extensions) and vitest under `test/ui/`. Run the whole suite as `NODE_PATH= pnpm test` (an inherited `NODE_PATH` makes `test/hive-cli.test.ts` find the real Electron and hang); it builds, runs `node --test "dist/test/*.test.js" "dist/test/boards/*.test.js"`, then `vitest run`. `pnpm lint` (Biome, warnings are errors) must stay clean; CI runs build, tests and lint on every PR.
- `NODE_PATH= pnpm test` must stay green after every task. Counts: `node:test` 298 today → 299 at the end (`config` +1; `setup-form`, `i18n` and `setup` fold their new assertions into existing tests whose literal `deepEqual`s have to change anyway); vitest 12 → 14 (`HiveBoard` +2; `ColumnEditor` extends its rows test).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `Column.visible?: number` (after `weight`, line 79) |
| `src/config.ts` | `parseColumn` reads `visible` with `requireInt`, absent stays absent; `legacyColumns` proposes `visible: 5` |
| `src/ui/i18n.ts` | new keys `column.cards`, `column.weight`, `column.more`, `column.less`, `setup.columns.visible`; `setup.columns.error` and `setup.columns.hint` updated, en + pt |
| `src/ui/lib/setup-form.ts` | `ColumnDraft.visible`, `DEFAULT_VISIBLE`, `isEmptyOrNonNegativeInt`, `limitFrom` moved up; `emptyColumn`, `columnDraft`, `columnFrom`, `columnsProblem`, `budgetProblem` |
| `src/ui/components/HiveBoard.tsx` | `ColumnCards` component with the cap and the toggle; header with count and weight |
| `src/ui/components/setup/ColumnEditor.tsx` | `visible` number input next to weight; first grid `md:grid-cols-5` |
| `README.md` | `"visible": 5` in the columns example; the field in the columns sentence and in the setup-form sentence |
| `test/config.test.ts` | +1: `visible` absent / `0` / `3` / `-1` / `1.5`; `legacyColumns` test expects `visible: 5` (19 → 20) |
| `test/setup.test.ts` | the legacy-proposal test expects `visible: 5` in the proposal and in the saved file (28, unchanged) |
| `test/i18n.test.ts` | new literal for `setup.columns.error`; `column.*` interpolation in en and pt; the new keys in the key list (4, unchanged) |
| `test/setup-form.test.ts` | `visible` through `draftFrom`, `validateSetup`, `toSetupBody`, `emptyColumn` (4, unchanged) |
| `test/ui/HiveBoard.test.tsx` | +2: cap, header and toggle; running cards and no limit (4 → 6) |
| `test/ui/ColumnEditor.test.tsx` | the rows test expects `visible: '5'` on a new row and types into `visíveis` (3, unchanged) |

---

### Task 1: Types + config — `Column.visible`, parsed as a non-negative integer, proposed as `5` by `legacyColumns` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`, `test/setup.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Column.visible?: number`.
- `parseColumn(raw, field)`: when `raw.visible !== undefined`, the result carries `visible: requireInt(raw.visible, \`${field}.visible\`)`; otherwise the key is absent. `legacyColumns` returns `visible: 5` on its one column.
- Consumed by: Task 3 (`columnDraft` / `columnFrom`), Task 4 (`ColumnCards`), the server for free (`POST /setup` already goes through `parseConfig`).

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, append after the `parseConfig reads columns as written…` test:

```ts
test('parseConfig reads columns[].visible as a non-negative integer, leaves it absent when unset and rejects the rest naming the index', () => {
  const column = (visible?: unknown) => ({ name: 'a', weight: 1, from: ['x'], ...(visible === undefined ? {} : { visible }) });
  assert.equal('visible' in parseConfig({ ...GITHUB, columns: [column()] }).columns[0], false, 'absent stays absent: no limit, and the file stays clean');
  assert.equal(parseConfig({ ...GITHUB, columns: [column(0)] }).columns[0].visible, 0, '0 is kept as written: no limit either');
  assert.equal(parseConfig({ ...GITHUB, columns: [column(3)] }).columns[0].visible, 3);
  for (const bad of [-1, 1.5, '5', null]) {
    assert.throws(() => parseConfig({ ...GITHUB, columns: [column(bad)] }), { message: 'hive.config.json: "columns[0].visible" must be a non-negative integer' }, JSON.stringify(bad));
  }
});
```

In the same file, in `legacyColumns turns status and promptTemplate…`, replace the expected column and add one assertion after `const [defaults] = legacyColumns({});`:

```ts
    { name: 'fila', weight: 1, visible: 5, session: 'new', from: ['Todo'], onStart: 'Doing', onFinish: 'Review', prompt: '/ship #{id}' },
```

```ts
  assert.equal(defaults.visible, 5, 'a new column in the user\'s eyes: same default as the editor');
```

In `test/setup.test.ts`, in `GET /setup in setup mode over a legacy file proposes legacyColumns…`, replace the `deepEqual` on `info.config?.columns` (line 240) and add one assertion after `assert.deepEqual(saved.columns[0].from, ['Ready']);`:

```ts
  assert.deepEqual(info.config?.columns, [{ name: 'fila', weight: 1, visible: 5, session: 'new', from: ['Todo'], onStart: 'In progress', onFinish: 'In review', prompt: '/ship #{id}' }]);
```

```ts
  assert.equal(saved.columns[0].visible, 5, 'the proposal\'s visible goes through parseColumn and lands in the file');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Property 'visible' does not exist on type 'Column'` (in `test/config.test.ts` and `test/setup.test.ts`).

- [ ] **Step 3: Edit `src/types.ts`**

In `Column`, after `weight: number; // …`:

```ts
  visible?: number; // cards shown before the "show more" toggle; absent or 0 = all; running cards always show and count against it
```

- [ ] **Step 4: Edit `src/config.ts`**

In `parseColumn`, after the `const session = …` line, add:

```ts
  const visible = raw.visible === undefined ? {} : { visible: requireInt(raw.visible, `${field}.visible`) }; // absent stays absent: no limit
```

and spread it in the returned object, after `...session`:

```ts
    ...optionalString(raw.prompt, `${field}.prompt`), ...session, ...visible, ...optionalString(raw.model, `${field}.model`),
```

In `legacyColumns`, add `visible: 5` next to `weight: 1`:

```ts
    name: LEGACY_COLUMN_NAME, weight: 1, visible: 5, session: 'new', from: [textOr(status.queue, LEGACY_STATUS.queue)],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 299 `node:test` PASS (`config` 20, `setup` 28), vitest 12 PASS. The existing `parseConfig reads columns as written…` test is untouched: none of its columns has `visible`, so `deepEqual` against the input still holds.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts test/setup.test.ts
git commit -m "feat(config): optional columns[].visible, a non-negative integer; the legacy proposal starts at 5"
```

---

### Task 2: i18n — `column.cards`, `column.weight`, `column.more`, `column.less`, `setup.columns.visible`; updated error and hint (TDD)

**Files:**
- Modify: `src/ui/i18n.ts`
- Test: `test/i18n.test.ts`

**Interfaces:**
- New `MessageKey`s: `column.cards` (`{n}`), `column.weight` (`{w}`), `column.more` (`{n}`), `column.less`, `setup.columns.visible`. `t()` already fills `{name}` placeholders from `vars` (`PLACEHOLDER = /\{(\w+)\}/g`, line 208), nothing changes in the function.
- The pt/en parity test (`pt and en have exactly the same keys and no empty text`) covers the new keys automatically once both dictionaries have them.
- Consumed by: Task 3 (`setup.columns.error`), Task 4 (`column.*`), Task 5 (`setup.columns.visible`).

- [ ] **Step 1: Write the failing test**

In `test/i18n.test.ts`, in `t fills {placeholders}…`, replace the `setup.columns.error` literal (line 42) and add three assertions in the `en` block and one in the `pt` block:

```ts
  assert.equal(t('setup.columns.error', { n: 2 }), 'column 2: enter a name, an integer weight ≥ 0 and, if set, an integer visible ≥ 0');
  assert.equal(t('column.cards', { n: 13 }), '13 cards');
  assert.equal(t('column.weight', { w: 3 }), 'weight 3');
  assert.equal(t('column.more', { n: 8 }), '+8 more');
```

```ts
  assert.equal(t('column.more', { n: 8 }), '+8 mais');
  assert.equal(t('column.less'), 'mostrar menos');
```

In `the board and column keys exist in both languages`, extend the key list:

```ts
  for (const key of ['board.title', 'card.start', 'card.missing', 'card.close', 'card.keep', 'card.orphan', 'confirm.close', 'setup.columns', 'setup.columns.add', 'setup.columns.hint', 'setup.columns.error', 'column.cards', 'column.weight', 'column.more', 'column.less', 'setup.columns.visible'] as const) {
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Argument of type '"column.cards"' is not assignable to parameter of type 'MessageKey'` (and the same for the other new keys).

- [ ] **Step 3: Edit `src/ui/i18n.ts`**

In `en`, after `'column.empty': 'empty',`:

```ts
  'column.cards': '{n} cards',
  'column.weight': 'weight {w}',
  'column.more': '+{n} more',
  'column.less': 'show less',
```

after `'setup.columns.weight': 'weight',`:

```ts
  'setup.columns.visible': 'visible',
```

replace `setup.columns.error`:

```ts
  'setup.columns.error': 'column {n}: enter a name, an integer weight ≥ 0 and, if set, an integer visible ≥ 0',
```

and in `setup.columns.hint` replace `a column without a prompt only shows the card. Prompt placeholders:` with:

```
a column without a prompt only shows the card; <code>visible</code> caps the cards shown before "show more" (empty = all; running cards always show). Prompt placeholders:
```

In `pt`, after `'column.empty': 'vazia',`:

```ts
  'column.cards': '{n} cards',
  'column.weight': 'peso {w}',
  'column.more': '+{n} mais',
  'column.less': 'mostrar menos',
```

after `'setup.columns.weight': 'peso',`:

```ts
  'setup.columns.visible': 'visíveis',
```

replace `setup.columns.error`:

```ts
  'setup.columns.error': 'coluna {n}: informe nome, peso inteiro ≥ 0 e, se preenchido, visíveis inteiro ≥ 0',
```

and in `setup.columns.hint` replace `coluna sem prompt só mostra o card. Placeholders do prompt:` with:

```
coluna sem prompt só mostra o card; <code>visíveis</code> limita os cards mostrados antes do "mostrar mais" (vazio = todos; cards rodando sempre aparecem). Placeholders do prompt:
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 299 `node:test` PASS (`i18n` 4), vitest 12 PASS. `test/setup-form.test.ts` still passes: it compares against `t('setup.columns.error', …)`, never against the literal. The hint still matches `/\{id\}/`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/i18n.ts test/i18n.test.ts
git commit -m "feat(i18n): column count, weight and show more / less strings; visible field in the setup copy"
```

---

### Task 3: Setup form model — `ColumnDraft.visible`, default `'5'`, empty or `0` = key absent, validation (TDD)

**Files:**
- Modify: `src/ui/lib/setup-form.ts`
- Test: `test/setup-form.test.ts`

**Interfaces:**
- `ColumnDraft` gains `visible: string`. `emptyColumn().visible === '5'` (`DEFAULT_VISIBLE`). `columnDraft(c)` maps `c.visible` through the existing `numberField` (absent or `0` → `''`, else the digits). `columnFrom(c)` maps `c.visible` through the existing `limitFrom` (`''`, `'0'` or garbage → key absent; otherwise `visible: Number`). `columnsProblem` flags a `visible` that is neither empty nor a non-negative integer with the same `setup.columns.error`.
- `budgetProblem` shares the new `isEmptyOrNonNegativeInt` helper (same rule it already applied inline).
- Consumed by: Task 5 (`ColumnEditor` reads and writes `column.visible`).

- [ ] **Step 1: Write the failing test**

In `test/setup-form.test.ts`:

Give `CONFIG.columns[0]` a cap:

```ts
    { name: 'spec', weight: 5, visible: 5, from: ['Backlog'], onFinish: 'Ready', prompt: '/hive-spec {url}', model: 'opus' },
```

In `draftFrom fills every field as strings…`, replace the `deepEqual` on `github.columns[0]` and add one line after it:

```ts
  assert.deepEqual(withoutId(github.columns[0]), { name: 'spec', weight: '5', visible: '5', session: 'new', model: 'opus', from: ['Backlog'], onStart: '', onFinish: 'Ready', prompt: '/hive-spec {url}' });
  assert.equal(github.columns[1].visible, '', 'no visible in the config = no limit = empty field');
```

In `validateSetup answers the tab and message…`, add after the `weight: '-1'` line:

```ts
  assert.deepEqual(validateSetup({ ...valid, columns: [{ ...valid.columns[0], visible: '-1' }] }), { tab: 'board', message: t('setup.columns.error', { n: 1 }) });
  assert.deepEqual(validateSetup({ ...valid, columns: [valid.columns[0], { ...valid.columns[1], visible: '1.5' }] }), { tab: 'board', message: t('setup.columns.error', { n: 2 }) });
  assert.equal(validateSetup({ ...valid, columns: [{ ...valid.columns[0], visible: '' }, { ...valid.columns[1], visible: '0' }] }), undefined, 'empty and 0 mean no limit');
```

In `toSetupBody emits only filled keys…`, replace the `bare.columns` assertion and the `emptyColumn()` shape, and add the no-limit case after the `bare` block:

```ts
  assert.deepEqual(bare.columns, [{ name: 'fila', weight: 1, visible: 5, from: ['Ready'] }], 'session=new, empty model / onStart / onFinish / prompt stay absent; the editor default visible=5 is sent');
```

```ts
  const unlimited = toSetupBody({ ...draftFrom(undefined), columns: [{ ...emptyColumn(), name: 'a', from: ['x'], visible: '' }, { ...emptyColumn(), name: 'b', from: [], visible: '0' }] });
  assert.deepEqual(unlimited.columns?.map((c) => 'visible' in c), [false, false], 'empty or 0 = no limit = key absent, so the file stays clean');
```

```ts
  assert.deepEqual(withoutId(emptyColumn()), { name: '', weight: '1', visible: '5', session: 'new', model: '', from: [], onStart: '', onFinish: '', prompt: '' });
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Object literal may only specify known properties, and 'visible' does not exist in type 'ColumnDraft'` / `Property 'visible' does not exist on type 'ColumnDraft'`.

- [ ] **Step 3: Edit `src/ui/lib/setup-form.ts`**

`ColumnDraft`:

```ts
export interface ColumnDraft { id: string; name: string; weight: string; visible: string; session: 'new' | 'continue'; model: string; from: string[]; onStart: string; onFinish: string; prompt: string }
```

Constants, after `const DEFAULT_WEIGHT = '1';`:

```ts
const DEFAULT_VISIBLE = '5'; // only for a column created in the editor; a config without the field keeps showing everything
```

`emptyColumn`:

```ts
export const emptyColumn = (): ColumnDraft => ({ id: crypto.randomUUID(), name: '', weight: DEFAULT_WEIGHT, visible: DEFAULT_VISIBLE, session: 'new', model: '', from: [], onStart: '', onFinish: '', prompt: '' });
```

Helpers: after `const isNonNegativeInt = …;` add the two lines below and delete the `limitFrom` line that today sits after `ruleFrom` (it moves here so `columnFrom` can share it):

```ts
const isEmptyOrNonNegativeInt = (text: string): boolean => text.trim() === '' || isNonNegativeInt(text);
const limitFrom = (text: string): number | undefined => (isNonNegativeInt(text) && Number(text) > 0 ? Number(text) : undefined); // empty or 0 = no limit
```

`columnDraft`:

```ts
const columnDraft = (c: Column): ColumnDraft => ({
  id: crypto.randomUUID(), name: c.name, weight: String(c.weight), visible: numberField(c.visible), session: c.session ?? 'new', model: c.model ?? '', from: c.from, onStart: c.onStart ?? '', onFinish: c.onFinish ?? '', prompt: c.prompt ?? '',
});
```

`columnsProblem` and `budgetProblem`:

```ts
function columnsProblem(columns: ColumnDraft[]): SetupProblem | undefined {
  if (columns.length === 0) return { tab: 'board', message: t('setup.columns.none') };
  const bad = columns.findIndex((c) => c.name.trim() === '' || !isNonNegativeInt(c.weight) || !isEmptyOrNonNegativeInt(c.visible));
  return bad === -1 ? undefined : { tab: 'board', message: t('setup.columns.error', { n: bad + 1 }) };
}
```

```ts
function budgetProblem(draft: SetupDraft): SetupProblem | undefined {
  const bad = [draft.budgetHour, draft.budgetDay].some((v) => !isEmptyOrNonNegativeInt(v));
  return bad ? { tab: 'limits', message: t('setup.budgetHint') } : undefined;
}
```

`columnFrom`:

```ts
// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean; the server validates the rest.
const columnFrom = (c: ColumnDraft): Column => {
  const visible = limitFrom(c.visible); // '' or '0' = no limit = key absent, like the budget fields
  return {
    name: c.name.trim(), weight: Number(c.weight), from: c.from,
    ...(c.session === 'continue' ? { session: 'continue' as const } : {}),
    ...(visible === undefined ? {} : { visible }),
    ...optional('model', c.model), ...optional('onStart', c.onStart), ...optional('onFinish', c.onFinish), ...optional('prompt', c.prompt),
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 299 `node:test` PASS (`setup-form` 4), vitest 12 PASS. `test/ui/ColumnEditor.test.tsx` still passes: its `expect.objectContaining({ name: '', weight: '1', … })` tolerates the extra `visible: '5'` until Task 5 tightens it.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/setup-form.ts test/setup-form.test.ts
git commit -m "feat(ui): visible in the column draft: default 5 for a new column, empty or 0 sends no key, validated as a non-negative integer"
```

---

### Task 4: `HiveBoard` — `ColumnCards` with the cap, the running-first rule and the `+N more` / `show less` toggle; header with count and weight (TDD)

**Files:**
- Modify: `src/ui/components/HiveBoard.tsx`
- Test: `test/ui/HiveBoard.test.tsx`

**Interfaces:**
- `ColumnCards({ cards, column, state })` (module-private): `expanded` via `useState(false)`; `cap = column.visible ?? 0`; `running = cards.filter((c) => c.slotId)`; `stopped = cards.filter((c) => !c.slotId).slice(0, Math.max(cap - running.length, 0))`; `collapsed = cap === 0 ? cards : cards.filter((c) => c.slotId || stopped.includes(c))` (array order kept); `hidden = cards.length - collapsed.length`. Renders `expanded ? cards : collapsed` as `BoardCard`s and, when `hidden > 0`, one `Button type="button" variant="ghost" size="xs"` toggling `expanded`, labelled `t('column.less')` when expanded, `t('column.more', { n: hidden })` otherwise. When `hidden` is `0` (no cap, a card left, config changed) there is no button and `expanded` is irrelevant.
- `HiveBoard`: header `${column.name} · ${t('column.cards', { n: cards.length })} · ${t('column.weight', { w: column.weight })}`; an empty column still shows `column.empty`, otherwise `<ColumnCards …/>`.
- `BoardCard` does not change.

- [ ] **Step 1: Write the failing tests**

In `test/ui/HiveBoard.test.tsx`, let `state` take the columns (default: today's) and add a capped column, after the `state` line:

```ts
const state = (cards: Card[], slots: Slot[], cols: Column[] = columns): State => ({ signal: 'green', maxConcurrent: slots.length, slots, columns: cols, cards, usage: [], budget: {}, usageRules: [] });
const capped: Column[] = [{ name: 'spec', weight: 5, visible: 2, from: ['Backlog'], prompt: '/hive-spec {url}' }];
const titles = () => screen.getAllByText(/^#\d Task/).map((el) => el.textContent);
```

Append two tests:

```tsx
test('a column with visible shows the first N stopped cards, the header counts them all, and the toggle reveals and hides the rest', async () => {
  setLanguage('en'); // the spec's strings; the other tests stay in pt
  const user = userEvent.setup();
  const cards = ['1', '2', '3', '4', '5'].map((id) => card(id, 'spec'));
  render(<HiveBoard state={state(cards, [slot('s1')], capped)} />);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('spec · 5 cards · weight 5');
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2']);
  await user.click(screen.getByRole('button', { name: '+3 more' }));
  expect(titles()).toHaveLength(5);
  expect(screen.queryByRole('button', { name: '+3 more' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'show less' }));
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2']);
  expect(screen.queryByRole('button', { name: 'show less' })).not.toBeInTheDocument();
});

test('running cards always show and count against visible; without visible (or 0) every card shows and there is no toggle', () => {
  const running = (id: string) => card(id, 'spec', { slotId: `s${id}` });
  const slots = [slot('s1', 'I1'), slot('s2', 'I2'), slot('s3', 'I3')];
  const cards = [card('4', 'spec'), running('1'), running('2'), card('5', 'spec'), running('3')]; // board order, running cards interleaved
  const { rerender } = render(<HiveBoard state={state(cards, slots, capped)} />);
  expect(titles()).toEqual(['#1 Task 1', '#2 Task 2', '#3 Task 3']); // 3 running > visible 2: no room for a stopped card
  expect(screen.getAllByRole('button', { name: 'terminal' })).toHaveLength(3);
  expect(screen.getByRole('button', { name: '+2 mais' })).toBeInTheDocument();
  rerender(<HiveBoard state={state(cards, slots, [{ ...capped[0], visible: 0 }])} />);
  expect(titles()).toHaveLength(5);
  expect(screen.queryByRole('button', { name: /mais|menos/ })).not.toBeInTheDocument();
  rerender(<HiveBoard state={state(cards, slots, [{ name: 'spec', weight: 5, from: ['Backlog'] }])} />);
  expect(titles()).toHaveLength(5);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('spec · 5 cards · peso 5');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test` (or, for the loop, `pnpm build && pnpm exec vitest run test/ui/HiveBoard.test.tsx`)
Expected: the build passes (types already compile after Task 1); the two new vitest tests fail at the heading assertion — `spec · 5` instead of `spec · 5 cards · weight 5`.

- [ ] **Step 3: Edit `src/ui/components/HiveBoard.tsx`**

Imports:

```tsx
import { useState } from 'react';
import { columnOf, isBlocked } from '../../cards';
import type { Card as CardModel, Column, Status, State } from '../../types';
```

Add between `BoardCard` and `HiveBoard`:

```tsx
interface ColumnCardsProps { cards: CardModel[]; column: Column; state: State }

/** Running cards always show and count against `column.visible`; the first stopped cards fill what is left, until the toggle reveals all. Absent or 0 = no cap. */
function ColumnCards({ cards, column, state }: ColumnCardsProps) {
  const [expanded, setExpanded] = useState(false);
  const cap = column.visible ?? 0;
  const running = cards.filter((c) => c.slotId);
  const stopped = cards.filter((c) => !c.slotId).slice(0, Math.max(cap - running.length, 0));
  const collapsed = cap === 0 ? cards : cards.filter((c) => c.slotId || stopped.includes(c)); // board order, only filtered
  const hidden = cards.length - collapsed.length; // 0 once a card leaves or the cap changes: the button goes and `expanded` no longer matters

  return (
    <>
      {(expanded ? cards : collapsed).map((card) => <BoardCard key={card.task.itemId} card={card} state={state} />)}
      {hidden > 0 && (
        <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((e) => !e)}>
          {expanded ? t('column.less') : t('column.more', { n: hidden })}
        </Button>
      )}
    </>
  );
}
```

Replace the body of `HiveBoard`:

```tsx
/** One card per configured column, each column's cards in board order behind the column's cap; a card's actions match what today's board offers. */
export function HiveBoard({ state }: HiveBoardProps) {
  return (
    <div className="flex gap-4 overflow-x-auto">
      {state.columns.map((column) => {
        const cards = state.cards.filter((c) => c.column === column.name);
        return (
          <Card key={column.name} className="min-w-56 flex-1 gap-2 p-3">
            <h3 className="text-muted-foreground text-xs uppercase">
              {`${column.name} · ${t('column.cards', { n: cards.length })} · ${t('column.weight', { w: column.weight })}`}
            </h3>
            {cards.length === 0
              ? <p className="text-muted-foreground text-xs">{t('column.empty')}</p>
              : <ColumnCards cards={cards} column={column} state={state} />}
          </Card>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test && pnpm lint`
Expected: 299 `node:test` PASS, 14 vitest PASS (`HiveBoard` 6), lint clean. The four existing `HiveBoard` tests are untouched: their columns have no `visible`, so `collapsed === cards` and no button appears; none of them asserts the header.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/HiveBoard.tsx test/ui/HiveBoard.test.tsx
git commit -m "feat(ui): cap the cards a column shows to visible, running first, with a show more / show less toggle and the total in the header (#46)"
```

---

### Task 5: `ColumnEditor` — `visible` number input next to weight (TDD)

**Files:**
- Modify: `src/ui/components/setup/ColumnEditor.tsx`
- Test: `test/ui/ColumnEditor.test.tsx`

**Interfaces:**
- `ColumnRow` gains one field between weight and session: `<Input id={\`${id}-visible\`} type="number" min={0} step={1} defaultValue={column.visible} onChange={(e) => onUpdate({ visible: e.target.value })} />` labelled `t('setup.columns.visible')`. The first grid goes from `md:grid-cols-4` to `md:grid-cols-5` so the row stays on one line on desktop.
- No other change: `update` / `move` / `remove` already spread patches immutably.

- [ ] **Step 1: Extend the existing test**

In `test/ui/ColumnEditor.test.tsx`, in `adding, moving and removing rows reach onChange…`, tighten the new-row shape and type into the new field after the `peso` block:

```tsx
  expect(onChange).toHaveBeenLastCalledWith([...columns, expect.objectContaining({ name: '', weight: '1', visible: '5', session: 'new', model: '', from: [], onStart: '', onFinish: '', prompt: '' })]);
```

```tsx
  await user.clear(within(rows[0]).getByLabelText('visíveis'));
  await user.type(within(rows[0]).getByLabelText('visíveis'), '3');
  expect(onChange).toHaveBeenLastCalledWith([{ ...columns[0], visible: '3' }, columns[1]]);
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `pnpm build && pnpm exec vitest run test/ui/ColumnEditor.test.tsx`
Expected: `Unable to find a label with the text of: visíveis`.

- [ ] **Step 3: Edit `src/ui/components/setup/ColumnEditor.tsx`**

Change the first grid's class to `grid grid-cols-2 gap-3 md:grid-cols-5` and insert after the weight `<div>`:

```tsx
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-visible`}>{t('setup.columns.visible')}</Label>
          <Input id={`${id}-visible`} type="number" min={0} step={1} defaultValue={column.visible} onChange={(e) => onUpdate({ visible: e.target.value })} />
        </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test && pnpm lint`
Expected: 299 `node:test` PASS, 14 vitest PASS (`ColumnEditor` 3), lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/setup/ColumnEditor.tsx test/ui/ColumnEditor.test.tsx
git commit -m "feat(ui): visible field in the column editor"
```

---

### Task 6: Docs — `visible` in the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- None. The setup hint was updated in Task 2; this task covers the other place that describes `columns[]` fields (README section `## Hive columns`, lines 87-101, and the setup-form sentence on line 51).

- [ ] **Step 1: Edit `README.md`**

Line 51, the setup-form sentence: replace `(name, prompt, session, model, weight and the board columns each one maps to)` with `(name, prompt, session, model, weight, visible cards and the board columns each one maps to)`.

Line 93, the example's first column:

```json
  { "name": "spec", "weight": 5, "visible": 5, "from": ["Backlog"], "onFinish": "Ready",
```

Line 101, the fields sentence: after `a \`weight\` (higher wins a free slot when several columns have stopped cards; ties by board order)` insert `, a \`visible\` cap (how many cards the column shows before a "show more" toggle; absent or \`0\` = all; running cards always show and count against it)`.

- [ ] **Step 2: Build, tests and lint**

Run: `NODE_PATH= pnpm test && pnpm lint`
Expected: 299 `node:test` PASS, 14 vitest PASS, lint clean (no source change; this is the final gate).

- [ ] **Step 3: Manual check**

Run `pnpm start` on a repo whose entry column has more than 5 cards, with `"visible": 5` on that column. The header reads `<name> · <N> cards · weight <W>`; 5 cards show, then a ghost `+<N-5> more`; clicking it shows everything and `show less`; reload collapses again. Set the signal to green so a worker starts on a card beyond the first 5: it appears at once among the visible ones (with `terminal`) and one stopped card drops below the toggle. Remove `visible` from the file and save from the form: everything shows, no button. In the setup form, a new column starts with `visible` = 5; `-1` or `1.5` in the field blocks the save with the `column N: …` message; an empty field saves a column without the key.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: columns[].visible in the README"
```

---

## Verification

- `NODE_PATH= pnpm test` green: 299 `node:test` (298 before; `config` 20, `setup` 28, `setup-form` 4, `i18n` 4) and 14 vitest (12 before; `HiveBoard` 6, `ColumnEditor` 3). `pnpm lint` clean.
- Manual, `pnpm start`, column with `"visible": 5` and 13 cards: header `… · 13 cards · weight …`, 5 cards, `+8 more`; click → 13 and `show less`; click → 5 (spec criteria: cap, header, toggle).
- Manual, same board, 3 running in a `visible: 2` column: the 3 running show with `terminal`, no stopped card, `+N more` counts the stopped ones (running always visible and counted).
- Manual, file without `visible` or with `0`: every card, no button, header still shows the count (nothing changes silently for an existing config).
- Manual, setup form: new column → `visible` = 5; legacy file → proposal with 5; `-1` / `1.5` rejected with the updated `setup.columns.error`; empty → key absent in `hive.config.json`.
- Forged file, optional: `"visible": "5"` or `-1` in `hive.config.json` → the Hive opens in setup mode with `"columns[0].visible" must be a non-negative integer`.

## Notes

- `columnDraft` uses the existing `numberField` instead of a literal `c.visible ?? ''`: the latter would put a number in a `string` field, and `numberField` already encodes "0 or absent = no limit = empty field" for the budget. A config with `visible: 0` therefore reopens as an empty field and saves without the key; both mean "no limit", so nothing changes for the user, and the file loses one redundant key.
- `columnFrom` reuses `limitFrom` for the same reason; it moves above `columnFrom` only so the file reads top-down (module-level `const`s are all initialised before any call).
- The collapsed set is computed as `cards.filter((c) => c.slotId || stopped.includes(c))` rather than a counter in `filter`: no mutable local, and it keeps board order without a sort. `includes` is O(n·room) on a list of a few dozen cards; not worth a `Set`.
- `hidden` is computed from the collapsed set even while expanded, so `show less` stays while there is something to hide and disappears on its own when a card leaves or the cap is lifted — no effect, no reset of `expanded`.
- `describeColumns` in `src/log.ts` keeps logging `name(weight)`: the cap is a display rule and does not belong in the boot line.
- Deliberate simplifications (all closed in the spec): no `localStorage`, no per-user setting, no scrollbar inside the column, no special case for the entry column, no change to fill or to any board write.
