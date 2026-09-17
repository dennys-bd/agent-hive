# Agent Hive — setup: seção única de limites (orçamento + faixas de uso): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two mechanisms that limit token usage — `budget` (item 5) and `usageRules` (item 6) — become editable in the same place: a `limites` section of the setup form, with the two budget fields explained and an editable table of usage rules, saved by the existing `POST /setup`. Item 6 kept `usageRules` out of the form on purpose ("rare tweak, done by hand"); this item reverts only that decision. `parseConfig`, the orchestrator, the reducer and the dashboard meter do not change. Issue #17.

**Architecture:** `SetupBody.usageRules?: UsageRule[]` mirrors `budget`: the form always sends it (empty table → `[]`), an API caller that omits the key keeps the file's rules (`saveSetup`: `usageRules: body.usageRules ?? current?.usageRules`); `parseConfig` stays the single validator, so a bad rule answers 400 with the `usageRules[i]…` message it already produces. The table lives in `src/ui/limits.ts` (new, DOM only, ~60 lines): `renderRules(rules)` fills `#rules tbody`, `addRuleRow(rule?)` appends one `<tr>` with `percent` / `maxWorkers` / `signal` / `remover`, `usageRulesFromForm()` reads the rows back in table order and throws `faixa N: informe máx. workers ou sinal` for a row with neither effect. `app.ts` grows by five lines: one import, `renderRules(config?.usageRules ?? [])` in `openSetup`, `usageRules: usageRulesFromForm()` in the `saveSetup` body (the body construction moves inside the existing `try`, so the thrown message lands in `setupError` and no POST happens), and the `add-rule` listener. `server.ts` serves `/ui/limits.js` with a route identical to `/ui/app.js` (explicit per-file routes, no `static`).

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions, `lib: dom` already on), Electron, Express 5, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-16-setup-limits-design.md` (extends `docs/superpowers/specs/2026-09-16-token-budget-design.md` and `docs/superpowers/specs/2026-09-16-usage-rules-design.md`; the v1 spec `docs/superpowers/specs/2026-09-15-agent-hive-design.md` is authoritative for everything else).

## Global Constraints

- All v1, setup, boards, signal, budget and usage-rules constraints hold (immutable reducer, `execFile` argv arrays — n/a here, tokens only via env, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `orchestrator.ts`, `config.ts`, `usage-rules.ts`, `usage.ts`, `state-store.ts`, `hive.ts`, `spawn.ts`, `hooks-settings.ts`, `main.ts`, `run.ts`, `board.ts` and `src/boards/*` do not change. `parseConfig` stays the only validator of `usageRules`; the form only adds the one check the HTML cannot express (a row with no effect).
- `UsageRule`, `Config` and `State` do not change; `SetupBody` gains exactly `usageRules?: UsageRule[]`. The config file format is unchanged: the form produces the same JSON that is written by hand today.
- The signal names stay `green` / `yellow` / `red` in the table's `<select>` (they are state names, not copy), as in the dashboard header. All other new copy is Portuguese: `limites`, `% do orçamento`, `máx. workers`, `sinal`, `remover`, `adicionar faixa`, and the two hints from the spec, verbatim.
- Rows are saved in table order; no sorting, no deduplication, no suggested default table (an empty config opens an empty table with only `adicionar faixa`).
- `src/ui/limits.ts` is DOM only: no Node imports, only `import type` from `../types.js`. It mirrors `SIGNALS` (`orchestrator.ts` pulls `node:crypto` into the browser), the same way `app.ts` mirrors `DEFAULT_CONFIG`. Under ~70 lines, every function under 50.
- `app.ts` is already over 400 lines: it grows by at most a handful of lines (import, one call in `openSetup`, one key in the body, one listener). Everything with its own state (dynamic rows) lives in `limits.ts`.
- ESM with `.js` import extensions; no new runtime dependencies; new source files under 400 lines, functions under 50 lines. Code comments in English.
- `test/setup.test.ts` keeps its fake factory and `maxConcurrent: 0`, so nothing spawns; it keeps the helper names `start`, `postSetup`, `json`, `configFile`, `BODY`.
- `src/ui/*` stays outside `node:test` (DOM only); Tasks 2 and 3 are checked by `pnpm build` and the manual checklist copied from the spec.
- `pnpm test` must stay green after every task (153 tests today → 154 at the end; confirm the starting number with `pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'` before Task 1 and adjust the expectations below by the same delta if it differs).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `SetupBody.usageRules?: UsageRule[]` with the doc comment from the spec |
| `src/server.ts` | `saveSetup`: `usageRules: body.usageRules ?? current?.usageRules` (the "not in the form" comment goes); `app.get('/ui/limits.js', …)` next to `/ui/app.js` |
| `src/ui/index.html` | budget row + `vazio = sem limite` hint replaced by `<fieldset id="limits">` (legend, budget row, budget hint, `<table id="rules">`, `adicionar faixa`, table hint); CSS for `legend`, `#rules`, small buttons in cells |
| `src/ui/limits.ts` (new) | `renderRules`, `addRuleRow`, `usageRulesFromForm` — DOM only |
| `src/ui/app.ts` | import from `./limits.js`; `renderRules` in `openSetup`; `usageRules: usageRulesFromForm()` in the body, built inside the `try`; `add-rule` listener |
| `test/setup.test.ts` | "usageRules come from the file only…" rewritten as "POST /setup with usageRules writes them…"; new "POST /setup with an invalid usage rule answers 400…" (+1 → 23) |

---

### Task 1: `SetupBody.usageRules` reaches `parseConfig` through `POST /setup` (TDD)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/server.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `SetupBody.usageRules?: UsageRule[]` — "The form always sends it (empty table = []); an API caller that omits it keeps the current rules."
- Produces (in `src/server.ts`): `saveSetup` passes `usageRules: body.usageRules ?? current?.usageRules` to `parseConfig`. `parseUsageRules` / `parseUsageRule` (item 6) validate and name the field; an error answers 400 through the existing `catch` and nothing is written. `configure` / `reconfigure` already dispatch `setUsageRules` when the config's rules differ from the State's, so `getState()?.usageRules` follows the file.
- Consumed by: Task 3 (`saveSetup` in `app.ts` sends `usageRules`).

- [x] **Step 1: Write the failing tests — rewrite the last test of `test/setup.test.ts`**

Replace the whole test `usageRules come from the file only: a second POST /setup keeps them and the live config and State carry them` (lines 329–343, the last test in the file) with these two:

```ts
test('POST /setup with usageRules writes them to hive.config.json, GET /setup returns them and the State carries them', async (t) => {
  const { base, repo, server } = await start(t);
  const usageRules = [{ percent: 50, maxWorkers: 1 }, { percent: 90, signal: 'red' }];
  assert.equal((await postSetup(base, { ...BODY, usageRules })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  // a save without the key keeps the file's; a save with [] clears them (the form always sends the table)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
  assert.equal((await postSetup(base, { ...BODY, usageRules: [] })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, []);
  assert.deepEqual(server.getState()?.usageRules, []);
});

test('POST /setup with an invalid usage rule answers 400 naming the rule and writes nothing', async (t) => {
  const { base, repo, server } = await start(t);
  const usageRules = [{ percent: 80, signal: 'yellow' }];
  assert.equal((await postSetup(base, { ...BODY, usageRules })).status, 200);
  const outOfRange = await postSetup(base, { ...BODY, usageRules: [{ percent: 101, signal: 'red' }] });
  assert.equal(outOfRange.status, 400);
  assert.match((await json<{ error: string }>(outOfRange)).error, /usageRules\[0\]\.percent/);
  const noEffect = await postSetup(base, { ...BODY, usageRules: [{ percent: 50 }] });
  assert.equal(noEffect.status, 400);
  assert.match((await json<{ error: string }>(noEffect)).error, /usageRules\[0\]/);
  // both rejected before the write: the file and the State still carry the valid rule
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).usageRules, usageRules);
  assert.deepEqual(server.getState()?.usageRules, usageRules);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build green (the bodies are `unknown`, so the extra key compiles). `POST /setup with usageRules writes them…` fails at the first `assert.deepEqual` (`[]` on disk: the body's `usageRules` is ignored). `POST /setup with an invalid usage rule…` fails at `assert.equal(outOfRange.status, 400)` (got 200: nothing in the body is validated). 152 pass, 2 fail.

- [x] **Step 3: Edit `src/types.ts`**

In `SetupBody`, after the `budget?: Budget;` line add:

```ts
  /** The form always sends it (empty table = []); an API caller that omits it keeps the current rules. */
  usageRules?: UsageRule[];
```

- [x] **Step 4: Edit `src/server.ts`**

In `saveSetup`, replace

```ts
        usageRules: current?.usageRules, // not in the form: comes from the file, like port and claudeArgs
```

with

```ts
        usageRules: body.usageRules ?? current?.usageRules,
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 154 tests PASS (`setup` 23). The `budget` test (`POST /setup with a budget…`) is untouched and still green: `parseConfig` gets `usageRules: undefined` from `BODY` and defaults it to `[]`.

- [x] **Step 6: Commit**

```bash
git add src/types.ts src/server.ts test/setup.test.ts
git commit -m "feat(setup): accept usageRules in POST /setup, falling back to the file"
```

---

### Task 2: The `limites` section — `src/ui/limits.ts`, the fieldset, the CSS and the route

**Files:**
- Create: `src/ui/limits.ts`
- Modify: `src/ui/index.html`
- Modify: `src/server.ts`

**Interfaces:**
- Produces (in `src/ui/limits.ts`):
  - `renderRules(rules: UsageRule[]): void` — clears `#rules tbody` and adds one row per rule, in array order
  - `addRuleRow(rule?: UsageRule): void` — appends a row (empty when no rule) and wires its `remover` button to remove that row
  - `usageRulesFromForm(): UsageRule[]` — one `UsageRule` per row in table order; `percent` from `Number(input.value)`, `maxWorkers` only when the field is not empty, `signal` only when the select is not `—`; throws `Error('faixa N: informe máx. workers ou sinal')` (N 1-based) for a row with neither effect. Absent keys are never set to `undefined` (spread pattern, like `budgetFromForm`).
- Produces (in `src/ui/index.html`): `<fieldset id="limits">` with `#budget-hour`, `#budget-day` (same ids as today, so `openSetup` / `budgetFromForm` keep working), `<table id="rules">` with an empty `<tbody>`, `<button type="button" id="add-rule">`.
- Produces (in `src/server.ts`): `GET /ui/limits.js` → `dist/src/ui/limits.js`.
- Consumed by: Task 3 (`app.ts` imports the three functions and wires `#add-rule`).

Note: the fieldset is never `disabled` — `#setup fieldset[disabled] { display: none }` is for the per-board-type fieldsets only. `#setup input[type=number]` and `#setup select` already style the cells' controls (`width: 100%`), so the CSS below only adds the legend, the table and the small button.

- [x] **Step 1: Create `src/ui/limits.ts`**

```ts
import type { Signal, UsageRule } from '../types.js';

// Mirrors SIGNALS in orchestrator.ts, which cannot be imported here (it pulls node:crypto into the browser).
const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
const NO_SIGNAL = ''; // the "—" option: this row does not change the signal

const tbody = (): HTMLTableSectionElement => document.querySelector('#rules tbody') as HTMLTableSectionElement;
const field = <T extends HTMLElement>(row: Element, selector: string): T => row.querySelector(selector) as T;

// Every interpolated value is a number, an empty string or a signal name, so no escaping is needed.
function rowHtml(rule?: UsageRule): string {
  const options = SIGNALS.map((s) => `<option value="${s}"${s === rule?.signal ? ' selected' : ''}>${s}</option>`);
  return `
    <td><input class="percent" type="number" min="0" max="100" step="1" required value="${rule?.percent ?? ''}"></td>
    <td><input class="max-workers" type="number" min="0" step="1" value="${rule?.maxWorkers ?? ''}"></td>
    <td><select class="signal"><option value="${NO_SIGNAL}">—</option>${options.join('')}</select></td>
    <td><button type="button" class="remove">remover</button></td>`;
}

/** Appends a row (empty when no rule) and wires its "remover" button. */
export function addRuleRow(rule?: UsageRule): void {
  const row = document.createElement('tr');
  row.innerHTML = rowHtml(rule);
  field<HTMLButtonElement>(row, 'button.remove').addEventListener('click', () => row.remove());
  tbody().appendChild(row);
}

/** Clears the table and adds one row per rule, in array order (no sorting: applyUsageRules ignores order). */
export function renderRules(rules: UsageRule[]): void {
  tbody().innerHTML = '';
  rules.forEach((rule) => addRuleRow(rule));
}

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean, like budgetFromForm.
function ruleFromRow(row: Element, index: number): UsageRule {
  const maxWorkers = field<HTMLInputElement>(row, 'input.max-workers').value;
  const signal = field<HTMLSelectElement>(row, 'select.signal').value;
  if (maxWorkers === '' && signal === NO_SIGNAL) throw new Error(`faixa ${index + 1}: informe máx. workers ou sinal`);
  return {
    percent: Number(field<HTMLInputElement>(row, 'input.percent').value),
    ...(maxWorkers === '' ? {} : { maxWorkers: Number(maxWorkers) }),
    ...(signal === NO_SIGNAL ? {} : { signal: signal as Signal }),
  };
}

/** One UsageRule per row, in table order. The browser enforces required / 0–100 / min 0; the server validates the rest. */
export function usageRulesFromForm(): UsageRule[] {
  return Array.from(tbody().rows).map(ruleFromRow);
}
```

- [x] **Step 2: Edit `src/ui/index.html` — the fieldset**

Replace the five lines between `máx. workers` and `prompt do worker`:

```html
  <div class="row">
    <label>tokens por hora <input id="budget-hour" type="number" min="0" step="1"></label>
    <label>tokens por dia <input id="budget-day" type="number" min="0" step="1"></label>
  </div>
  <div class="hint">vazio = sem limite</div>
```

with:

```html
  <fieldset id="limits">
    <legend>limites</legend>
    <div class="row">
      <label>tokens por hora <input id="budget-hour" type="number" min="0" step="1"></label>
      <label>tokens por dia <input id="budget-day" type="number" min="0" step="1"></label>
    </div>
    <div class="hint">totais por hora e por dia; ao estourar, nenhum job novo abre (os que estão rodando terminam). Vazio = sem limite.</div>
    <table id="rules">
      <thead><tr><th>% do orçamento</th><th>máx. workers</th><th>sinal</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <button type="button" id="add-rule">adicionar faixa</button>
    <div class="hint">faixas cumulativas: ao passar de uma faixa, valem todas as anteriores (o pior sinal e o menor teto). O sinal manual do dashboard vence quando é mais restritivo.</div>
  </fieldset>
```

- [x] **Step 3: Edit `src/ui/index.html` — the CSS**

After the line `  #setup fieldset[disabled] { display: none; }` add:

```css
  #setup legend { font-size: 13px; color: var(--muted); text-transform: uppercase; padding: 0; margin: 0 0 8px; }
  #rules { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  #rules th { text-align: left; font-weight: normal; color: var(--muted); font-size: 12px; padding: 0 4px 4px 0; }
  #rules td { padding: 0 4px 4px 0; }
  #rules td button { padding: 3px 8px; font-size: 12px; }
  #add-rule { margin-bottom: 12px; }
```

- [x] **Step 4: Edit `src/server.ts` — the route**

After `  app.get('/ui/app.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'app.js')));` add:

```ts
  app.get('/ui/limits.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'limits.js')));
```

- [x] **Step 5: Build and test**

Run: `pnpm test`
Expected: build green (`limits.ts` compiles under `strict` with the `dom` lib already in `tsconfig.json`; `HTMLTableSectionElement.rows` is a `HTMLCollectionOf<HTMLTableRowElement>`, so `Array.from(…).map(ruleFromRow)` types); 154 tests PASS (nothing imports `limits.ts` yet). `ls dist/src/ui/` lists `app.js`, `limits.js`, `index.html`.

- [x] **Step 6: Commit**

```bash
git add src/ui/limits.ts src/ui/index.html src/server.ts
git commit -m "feat(setup): limites section — budget copy and the usage rules table module"
```

---

### Task 3: `app.ts` wiring — render on open, read on save, add a row

**Files:**
- Modify: `src/ui/app.ts`

**Interfaces:**
- Consumes: `addRuleRow`, `renderRules`, `usageRulesFromForm` from Task 2; `SetupBody.usageRules` from Task 1.
- `openSetup` renders the table from `setupInfo.config.usageRules` (`[]` before the first setup).
- `saveSetup` builds the body inside the existing `try`: `usageRulesFromForm()` throwing lands in `setupError` through the same `catch` that shows server errors, and no `POST` happens. `save.disabled = true` and `setupError()` run before the `try`, as today; `finally` re-enables the button in every path.
- The `#add-rule` click appends an empty row. Native validation (`required`, `min`, `max`) runs on submit before `saveSetup`, as for every other field.

- [x] **Step 1: Edit `src/ui/app.ts` — import**

After the closing `} from '../types.js';` of the type import (line 4) add:

```ts
import { addRuleRow, renderRules, usageRulesFromForm } from './limits.js';
```

- [x] **Step 2: Edit `src/ui/app.ts` — `openSetup`**

After `  $<HTMLInputElement>('budget-day').value = budgetField(config?.budget.maxTokensPerDay);` add:

```ts
  renderRules(config?.usageRules ?? []);
```

- [x] **Step 3: Edit `src/ui/app.ts` — `saveSetup`**

Replace the function in full with:

```ts
async function saveSetup(): Promise<void> {
  const board = boardFromForm();
  if (!board) {
    setupError(boardType() === 'markdown' ? 'informe o caminho do arquivo' : 'escolha um project');
    return;
  }
  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  setupError();
  try {
    // usageRulesFromForm throws for a row with no effect: the message lands in setupError and nothing is posted
    const body: SetupBody = {
      board,
      status: statusFromForm(),
      maxConcurrent: Number($<HTMLInputElement>('max-workers').value),
      promptTemplate: $<HTMLTextAreaElement>('prompt-template').value,
      budget: budgetFromForm(),
      usageRules: usageRulesFromForm(),
    };
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
    closeSetup();
    showNotice(result.restartForPort ? `reinicie o Hive pra usar a porta ${result.restartForPort}` : undefined);
  } catch (err) {
    setupError((err as Error).message);
  } finally {
    save.disabled = false;
  }
}
```

- [x] **Step 4: Edit `src/ui/app.ts` — listener**

After `$('cancel').addEventListener('click', closeSetup);` add:

```ts
$('add-rule').addEventListener('click', () => addRuleRow());
```

- [x] **Step 5: Build and test**

Run: `pnpm test`
Expected: 154 tests PASS (UI compiles under `strict`; `app.ts` lands at ~428 lines, +5 net). `saveSetup` stays under 30 lines.

- [ ] **Step 6: Manual check (from the spec's "Testes"; `pnpm start <repo>` on a repo with a markdown board and `máx. workers = 0`)**

Put in `hive.config.json`:

```jsonc
{
  "budget": { "maxTokensPerHour": 2000000, "maxTokensPerDay": 20000000 },
  "usageRules": [
    { "percent": 50, "maxWorkers": 4 },
    { "percent": 80, "signal": "yellow" }
  ]
}
```

1. Open `configurar`: the `limites` section shows `tokens por hora` = 2000000, `tokens por dia` = 20000000, the budget hint, and the table with two rows (`50 / 4 / —`, `80 / (empty) / yellow`).
2. Click `remover` on the first row, click `adicionar faixa`, type `60` in `% do orçamento` and leave `máx. workers` empty and `sinal` on `—`, click `salvar`: `setup-error` reads `faixa 2: informe máx. workers ou sinal`, `hive.config.json` is unchanged (no request in the network tab), the form stays open, `salvar` is enabled again.
3. Set that row's `máx. workers` to `2`, `salvar`: the form closes; `hive.config.json` has `usageRules: [{ "percent": 80, "signal": "yellow" }, { "percent": 60, "maxWorkers": 2 }]` — table order, no sorting, no `undefined` keys; `curl -s localhost:47821/setup` returns the same two rules.
4. Leave `% do orçamento` empty on a new row and `salvar`: the browser's native `required` bubble blocks the submit; `101` is blocked by `max`.

- [x] **Step 7: Commit**

```bash
git add src/ui/app.ts
git commit -m "feat(setup): wire the usage rules table into openSetup and saveSetup"
```

---

### Task 4: Final verification and the PR body

**Files:** none.

- [ ] **Step 1: Full test run**

Run: `pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'`
Expected: `# tests 154`, `# pass 154`, `# fail 0`.

- [ ] **Step 2: Acceptance per the spec's "Critério de pronto" (manual, `pnpm start <repo>`, markdown board, `máx. workers = 0`)**

1. With `hive.config.json` without `usageRules` (and without `budget`): `configurar` shows the `limites` section with the two budget fields and their hint, and an empty table with only `adicionar faixa`. Add a row `80 / (empty) / yellow` and `salvar`: the file has `"usageRules": [{ "percent": 80, "signal": "yellow" }]`, and `curl -s localhost:47821/events | head -c 2000` (or the SSE payload in the network tab) shows `usageRules` with that rule in the live State (item 6 then applies it: effective signal `yellow` above 80 %).
2. Reopen `configurar`: the same row shows; `salvar` without touching anything leaves `hive.config.json` byte-identical (`git diff` / `stat -f %m` before and after).
3. `pnpm test` green (154); `git diff main --stat` touches only `src/types.ts`, `src/server.ts`, `src/ui/index.html`, `src/ui/app.ts`, `src/ui/limits.ts`, `test/setup.test.ts` and the docs — `parseConfig`, the orchestrator and the meter are untouched.

- [ ] **Step 3: PR body recap**

The PR body lists: the three commits; `pnpm test` 154 PASS; the manual checklist of Task 3 Step 6 and Task 4 Step 2 with a line per item marked done; the note that `usageRules` in `POST /setup` mirrors `budget` (absent key keeps the file, `[]` clears) and that `parseConfig` remains the only validator.
