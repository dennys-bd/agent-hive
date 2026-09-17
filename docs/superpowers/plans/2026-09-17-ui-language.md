# Agent Hive — idioma da interface configurável (pt, en): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI speaks `pt` or `en`. `language` in `hive.config.json` decides; absent, the system locale decides (`pt*` → `pt`, anything else → `en`). `GET /setup` returns the effective language, the setup form has a `language` select on the general tab, and saving switches every visible text without a reload. Prerequisite: the reducer and `state.json` stop carrying Portuguese: `Status` becomes `'empty' | 'working' | 'waiting' | 'review'` and `lastEvent` becomes `{ kind, detail? }`; the text only exists at render time, in `src/ui/i18n.ts`. The worker's status line (`formatRateLimits`) and the Electron folder dialog follow the language too. Server error messages, adapters, `parseConfig`, console and `hive.log` stay as they are.

**Architecture:** `src/language.ts` (`LANGUAGES`, `languageFrom`, `systemLanguage`) is the only detection code; `main.ts` feeds it `app.getLocale()`, `run.ts` relies on the Node locale. `ServerDeps.systemLanguage` reaches `createServer`, which computes the effective language (`config.language ?? systemLanguage`) for `GET /setup` and `POST /hooks/status`. `POST /setup` accepts `body.language` and `parseConfig` validates it (absent stays absent). `src/state-store.ts` maps a legacy `state.json` on load. `src/ui/i18n.ts` holds `MESSAGES` (en reference, pt with the same keys), `LOCALE`, `setLanguage`, `t`, `statusText`, `slotEventText`, `applyTranslations`; it is served as `/ui/i18n.js` and tested from node like `highlight.ts`. `index.html` keeps only keys (`data-i18n`, `data-i18n-html`, `data-i18n-placeholder`); `app.ts` and `limits.ts` render through `t`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions, `lib: dom`), Electron, Express 5, `node:test` + `node:assert/strict`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-ui-language-design.md` (extends `2026-09-15-agent-hive-design.md`, `2026-09-16-hive-cli-and-setup-design.md`, `2026-09-16-rate-limits-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/44>. Plan file: `docs/superpowers/plans/2026-09-17-ui-language.md`.

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, tokens only via env, conventional commits `<type>: <description>` in English without trailers, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- Every row of the spec's "Decisões fechadas" table is closed: two languages, optional `language` with system fallback, `pt*` → `pt` else `en`, locale sources per mode, `GET /setup` carries the effective language, select on the general tab, the new `Status` and `SlotEvent` shapes, the legacy `state.json` mapping, one dictionary file served as `/ui/i18n.js`, keys-only HTML, `LOCALE` for `toLocale*`, `formatRateLimits(limits, language)`, the dialog title, and what stays out (route / adapter / `parseConfig` / console / `hive.log` messages).
- `pt` copy is byte-identical to what the UI shows today (`index.html`, `app.ts`, `limits.ts`, the reducer's `lastEvent` sentences). `en` copy is lowercase where `pt` is lowercase. The markdown header `| id | título | status |` inside the hint is the file format (`EXPECTED_HEADER` in `src/boards/markdown.ts`), not UI copy: identical in both languages.
- The served UI module graph is explicit routes in `server.ts` (`/ui/app.js`, `/ui/limits.js`, `/ui/highlight.js`): `i18n.ts` gets its own route and imports only types from `../types.js` (erased by `tsc`); UI files never import server modules.
- Signal names stay `green` / `yellow` / `red` in both languages (never translated).
- `src/server.ts` (551 lines) and `src/ui/app.ts` (535 lines) already exceed the 400-line bullet; this plan adds about 15 lines to the first and swaps strings in the second, no refactor. Other files < 400 lines, functions < 50 lines, code comments in English.
- Tests: `node:test` + `node:assert/strict` under `test/`, ESM with `.js` import extensions. Run the suite as `NODE_PATH= pnpm test` (an inherited `NODE_PATH` makes `test/hive-cli.test.ts` find the real Electron and hang).
- `NODE_PATH= pnpm test` must stay green after every task (252 tests today → 264 at the end). One commit per green task.

---

## File map

| File | Change |
|---|---|
| `src/language.ts` | new — `LANGUAGES`, `languageFrom`, `systemLanguage` |
| `src/types.ts` | `Language`, new `Status`, `SlotEventKind`, `SlotEvent`; `Slot.lastEvent?: SlotEvent`; `Config.language?`, `SetupBody.language?`, `SetupInfo.language` |
| `src/config.ts` | `parseConfig` reads optional `language` ∈ `LANGUAGES` (spread: absent stays absent) |
| `src/orchestrator.ts` | `STATUSES`; status literals → keys; `lastEvent` → `SlotEvent` objects |
| `src/state-store.ts` | `normalizeSlot`: legacy statuses mapped, unknown → `{ id, status: 'empty' }`, string `lastEvent` dropped |
| `src/log.ts` | `'vazio'` → `'empty'` in `describeChanges` |
| `src/rate-limits.ts` | `LABELS` per language; `windowLabel(key, language)`, `formatRateLimits(limits, language)` |
| `src/server.ts` | `ServerDeps.systemLanguage?`; `effectiveLanguage()`; `GET /setup` carries it; `POST /hooks/status` uses it; `saveSetup` forwards `body.language ?? current?.language`; route `/ui/i18n.js`; literal swaps |
| `src/hive.ts` | `bootHive(repo, { locale? })` → `systemLanguage` into `createServer` (both modes) |
| `src/main.ts` | dialog title per `languageFrom(app.getLocale())`; passes `locale` to `bootHive` |
| `src/ui/i18n.ts` | new — `MESSAGES`, `MessageKey`, `LOCALE`, `setLanguage`, `t`, `statusText`, `slotEventText`, `applyTranslations` |
| `src/ui/index.html` | keys only; CSS vars / classes renamed; `<select id="language">` on the general tab; `<html lang="en">` |
| `src/ui/app.ts` | `applyLanguage` on init and after save; every literal through `t`; `LOCALE` for `toLocale*`; language field read / write |
| `src/ui/limits.ts` | `remover` and the tier error through `t` |
| `README.md` | `language` row in the config table |
| `test/language.test.ts` | new — 2 tests |
| `test/i18n.test.ts` | new — 4 tests |
| `test/config.test.ts` | +1 (16) |
| `test/state-store.test.ts` | +1 (9) |
| `test/orchestrator.test.ts`, `test/server.test.ts`, `test/log.test.ts` | literal swaps; `lastEvent` asserts become `deepEqual` (59 / 15 / 11, unchanged) |
| `test/rate-limits.test.ts` | existing test passes `'pt'`; +1 English test (8) |
| `test/setup.test.ts` | `start(t, delay, systemLanguage?)`; two asserts updated to the `en` default; +2 (28) |
| `test/hive.test.ts` | +1 (6) |

---

### Task 1: `src/language.ts` — `Language`, `LANGUAGES`, `languageFrom`, `systemLanguage` (TDD)

**Files:**
- Create: `src/language.ts`, `test/language.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `export type Language = 'pt' | 'en';`
- Produces (in `src/language.ts`):
  - `export const LANGUAGES: readonly Language[] = ['pt', 'en'];`
  - `export function languageFrom(locale: string | undefined): Language` — `/^pt\b/i` → `'pt'`, anything else (including `''` and `undefined`) → `'en'`.
  - `export function systemLanguage(): Language` — `languageFrom(Intl.DateTimeFormat().resolvedOptions().locale)` (Node reads `LANG`; Electron's main process too, but `main.ts` passes `app.getLocale()` explicitly).
- Consumed by: Task 2 (`parseConfig`), Task 4 (`server.ts`, `hive.ts`, `main.ts`, `rate-limits.ts`), Task 5 (`Language` type only).

- [ ] **Step 1: Write the failing tests — `test/language.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, languageFrom, systemLanguage } from '../src/language.js';

test('languageFrom reads any locale that starts with pt as pt and everything else, including nothing, as en', () => {
  assert.equal(languageFrom('pt-BR'), 'pt');
  assert.equal(languageFrom('pt'), 'pt');
  assert.equal(languageFrom('PT-PT'), 'pt');
  assert.equal(languageFrom('en-US'), 'en');
  assert.equal(languageFrom('fr'), 'en');
  assert.equal(languageFrom(''), 'en');
  assert.equal(languageFrom(undefined), 'en');
  assert.equal(languageFrom('ptx'), 'en', 'pt must be the whole language tag');
});

test('systemLanguage is one of LANGUAGES and matches the Node locale', () => {
  assert.deepEqual(LANGUAGES, ['pt', 'en']);
  const detected = systemLanguage();
  assert.ok(LANGUAGES.includes(detected));
  assert.equal(detected, languageFrom(Intl.DateTimeFormat().resolvedOptions().locale));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Cannot find module '../src/language.js'`.

- [ ] **Step 3: Edit `src/types.ts`**

Add after the `LogLevel` import:

```ts
export type Language = 'pt' | 'en';
```

- [ ] **Step 4: Create `src/language.ts`**

```ts
import type { Language } from './types.js';

export const LANGUAGES: readonly Language[] = ['pt', 'en'];
const PORTUGUESE = /^pt\b/i; // pt, pt-BR, PT-PT; the issue fixes English as the fallback for everything else

/** The UI language for a BCP 47 locale: Portuguese for any `pt*` tag, English for anything else or nothing at all. */
export function languageFrom(locale: string | undefined): Language {
  return locale !== undefined && PORTUGUESE.test(locale) ? 'pt' : 'en';
}

/** What the process runs under: Node resolves it from LANG; Electron passes app.getLocale() instead. */
export function systemLanguage(): Language {
  return languageFrom(Intl.DateTimeFormat().resolvedOptions().locale);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 254 tests PASS (`language` 2).

- [ ] **Step 6: Commit**

```bash
git add src/language.ts src/types.ts test/language.test.ts
git commit -m "feat(language): pt / en detection from a locale, en as the fallback"
```

---

### Task 2: `Config.language` — optional, validated, absent stays absent; README row (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `README.md`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Config.language?: Language`.
- Produces (in `src/config.ts`): `parseConfig` accepts an optional `language` ∈ `LANGUAGES`; error `hive.config.json: "language" must be one of: pt, en`; when `raw.language === undefined` the returned object has no `language` key (spread, never an explicit `undefined`, so `writeConfigFile` keeps the file clean and `test/setup.test.ts`'s `{ ...DEFAULT_CONFIG, ...BODY }` comparison still holds). `DEFAULT_CONFIG` does not change.
- Consumed by: Task 4 (`saveSetup`, `effectiveLanguage`).

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts` after the `logLevel` test:

```ts
test('parseConfig accepts language pt or en, leaves the key absent when unset and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, language: 'en' }).language, 'en');
  assert.equal(parseConfig({ board: GITHUB, language: 'pt' }).language, 'pt');
  assert.equal('language' in parseConfig({ board: GITHUB }), false, 'absent stays absent so writeConfigFile keeps the file clean');
  assert.throws(() => parseConfig({ board: GITHUB, language: 'fr' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ board: GITHUB, language: 'pt-BR' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ board: GITHUB, language: true }), /"language" must be one of: pt, en/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Property 'language' does not exist on type 'Config'`.

- [ ] **Step 3: Edit `src/types.ts`**

In `Config`, add after `logLevel: LogLevel; …`:

```ts
  language?: Language; // UI language; absent = the system's (never written as undefined: the file stays clean)
```

- [ ] **Step 4: Edit `src/config.ts`**

Imports — add after the `./log.js` line and extend the types import:

```ts
import { LANGUAGES } from './language.js';
import type { BoardConfig, Budget, Config, EpicsMode, Language, Signal, StatusKey, UsageRule, WorkersMode } from './types.js';
```

Add after `requireSignal`:

```ts
function requireLanguage(value: unknown): Language {
  if (!LANGUAGES.includes(value as Language)) throw new Error(`${CONFIG_FILE}: "language" must be one of: ${LANGUAGES.join(', ')}`);
  return value as Language;
}
```

In `parseConfig`'s returned object, add after the `logLevel: optional(…)` entry:

```ts
    ...(raw.language === undefined ? {} : { language: requireLanguage(raw.language) }), // absent stays absent: the system decides
```

- [ ] **Step 5: Edit `README.md`**

In the config table, add after the `logLevel` row:

```md
| `language` | system (`pt` when the OS locale starts with `pt`, else `en`) | form (`pt` or `en`; the dashboard and the setup form switch on save, no reload) |
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 255 tests PASS (`config` 16).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts README.md test/config.test.ts
git commit -m "feat(config): optional language (pt | en), absent means the system locale"
```

---

### Task 3: Neutral reducer data — `Status` keys, `SlotEvent`, legacy `state.json` mapping (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`, `src/state-store.ts`, `src/server.ts`, `src/log.ts`
- Test: `test/state-store.test.ts`, `test/orchestrator.test.ts`, `test/server.test.ts`, `test/log.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `export type Status = 'empty' | 'working' | 'waiting' | 'review';`
  - `export type SlotEventKind = 'starting' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'paused' | 'turn';`
  - `export interface SlotEvent { kind: SlotEventKind; detail?: string } // detail: the tool summary, or the notification kind`
  - `Slot.lastEvent?: SlotEvent`.
- Produces (in `src/orchestrator.ts`): `export const STATUSES: readonly Status[] = ['empty', 'working', 'waiting', 'review'];` and the mapping of the spec table (no rule changes): `'vazio'` → `'empty'`, `'trabalhando'` → `'working'`, `'esperando_voce'` → `'waiting'`, `'aguardando_review'` → `'review'`; `lastEvent: 'iniciando'` → `{ kind: 'starting' }`, `'prompt enviado'` → `{ kind: 'prompt' }`, `describeTool(p)` → `{ kind: 'tool', detail: describeTool(p) }`, `` `aguardando: ${kind}` `` → `{ kind: 'waiting', detail: kind }`, `'PR aberto'` → `{ kind: 'pr' }`, `'pausado: sinal red'` → `{ kind: 'paused' }`, `'turno encerrado'` → `{ kind: 'turn' }`.
- Produces (in `src/state-store.ts`): `normalizeSlot(slot)` — a status in `STATUSES` is kept; `vazio` / `trabalhando` / `esperando_voce` / `aguardando_review` map to the new keys; any other status → `{ id: slot.id, status: 'empty' }` (only the id survives; boot gives every occupied slot as dead anyway); `lastEvent` is kept only when it is `{ kind ∈ SlotEventKind, detail?: string }` (a legacy sentence or a bad object is dropped, key absent).
- `src/server.ts` and `src/log.ts`: literal swaps only (`'vazio'` → `'empty'` at `killStrays`, `turnTokens`, `GET /slots/:id/output`; `'aguardando_review'` → `'review'` in the kill-after-PR rule of `POST /hooks/event`; `describeChanges`). `SLOT_EMPTY_MESSAGE` is an error message: unchanged.
- Consumed by: Task 5 (`statusText`, `slotEventText`), Task 6 (`renderCard`, CSS classes).

- [ ] **Step 1: Write the failing test — `test/state-store.test.ts`**

Append:

```ts
test('loadState maps the legacy Portuguese statuses, empties a slot with an unknown status and drops a lastEvent that is not a SlotEvent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const task = { itemId: 'I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1' };
  const slots = [
    { id: 'a', status: 'trabalhando', workerId: 'w1', task, slug: 'hive-1-t', lastEvent: 'iniciando' },
    { id: 'b', status: 'esperando_voce', workerId: 'w2', task, lastEvent: 'aguardando: permission_prompt' },
    { id: 'c', status: 'aguardando_review', workerId: 'w3', task, prUrl: 'https://github.com/o/r/pull/1' },
    { id: 'd', status: 'vazio' },
    { id: 'e', status: 'busy', workerId: 'w5', task },
    { id: 'f', status: 'working', workerId: 'w6', task, lastEvent: { kind: 'tool', detail: 'Bash: ls' } },
    { id: 'g', status: 'review', workerId: 'w7', task, lastEvent: { kind: 'nope' } },
    { id: 'h', status: 'constructor' },
  ];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(0), slots }));
  const loaded = await loadState(dir, 8);
  assert.deepEqual(loaded.slots.map((s) => s.status), ['working', 'waiting', 'review', 'empty', 'empty', 'working', 'review', 'empty']);
  assert.deepEqual(loaded.slots[0], { id: 'a', status: 'working', workerId: 'w1', task, slug: 'hive-1-t' }, 'the sentence is dropped, the rest is kept');
  assert.equal('lastEvent' in loaded.slots[1], false);
  assert.deepEqual(loaded.slots[4], { id: 'e', status: 'empty' }, 'unknown status: only the id survives');
  assert.deepEqual(loaded.slots[5].lastEvent, { kind: 'tool', detail: 'Bash: ls' }, 'a SlotEvent object is kept as is');
  assert.equal('lastEvent' in loaded.slots[6], false, 'an unknown kind is dropped');
  assert.deepEqual(loaded.slots[7], { id: 'h', status: 'empty' }, 'an inherited property name is not a legacy status');
});
```

- [ ] **Step 2: Swap the literals in the existing tests**

The four status words appear only as status literals (or inside `slot 1: … → …` log lines) in these three files, so a blind replace is safe. On macOS:

```bash
sed -i '' -e 's/esperando_voce/waiting/g; s/aguardando_review/review/g; s/trabalhando/working/g; s/vazio/empty/g' test/orchestrator.test.ts test/server.test.ts test/log.test.ts src/log.ts
```

Do **not** run it on `src/server.ts` (`SLOT_EMPTY_MESSAGE` contains `vazio`) or `src/orchestrator.ts` (edited by hand below). Then, by hand in `test/orchestrator.test.ts`:

- line 159: `assert.deepEqual(tool.slots[0].lastEvent, { kind: 'tool', detail: 'Bash: pnpm test' });`
- lines 203, 391, 425: `assert.deepEqual(<x>.slots[0].lastEvent, { kind: 'turn' });`
- lines 385, 545: `assert.deepEqual(<x>.slots[0].lastEvent, { kind: 'paused' });`
- add in `poll fills slots in board order…` after `assert.ok(state.slots[0].startedAt);`: `assert.deepEqual(state.slots[0].lastEvent, { kind: 'starting' });`
- add in `Notification of a waiting type…` after the `question` assert: `assert.deepEqual(state.slots[0].lastEvent, { kind: 'waiting', detail: 'permission_prompt' });`
- add in `UserPromptSubmit and PreToolUse bring…` after `assert.equal(green.slots[0].question, undefined);`: `assert.deepEqual(green.slots[0].lastEvent, { kind: 'prompt' });`
- add in `PostToolUse with gh pr create…` after the `prUrl` assert: `assert.deepEqual(state.slots[0].lastEvent, { kind: 'pr' });`

All seven kinds are now asserted. Test counts do not change.

- [ ] **Step 3: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build errors — `Type '"working"' is not assignable to type 'Status'` (tests and `src/log.ts`), `Property 'kind' does not exist…` in the state-store test.

- [ ] **Step 4: Edit `src/types.ts`**

Replace the `Status` line and add the event types:

```ts
export type Status = 'empty' | 'working' | 'waiting' | 'review';
export type SlotEventKind = 'starting' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'paused' | 'turn';
/** What the slot last did, as a key the UI turns into text; `detail` is the tool summary (`Bash: pnpm test`) or the notification kind. */
export interface SlotEvent {
  kind: SlotEventKind;
  detail?: string;
}
```

In `Slot`: `lastEvent?: SlotEvent;`.

- [ ] **Step 5: Edit `src/orchestrator.ts`**

Add after `SIGNALS`:

```ts
export const STATUSES: readonly Status[] = ['empty', 'working', 'waiting', 'review'];
```

Replace every `'vazio'` with `'empty'` (lines 27, 28, 89, 103, 117, 141, 146, 174, 178 — `{ id: s.id, status: 'empty' as Status }`, 191, 222); `activeStatus` returns `slot.prUrl ? 'review' : 'working'`; in `fill` the new slot is `status: 'working', … lastEvent: { kind: 'starting' }`; in `applyHook`:

```ts
    case 'UserPromptSubmit':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: { kind: 'prompt' } });
    case 'PreToolUse':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: { kind: 'tool', detail: describeTool(p) } });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      return patch(state, workerId, { status: 'waiting', question: String(p.message ?? kind), lastEvent: { kind: 'waiting', detail: kind } });
    }
    case 'PostToolUse': {
      …
      const patched = patch(state, workerId, { status: 'review', prUrl, question: undefined, lastEvent: { kind: 'pr' } });
      …
    }
    case 'Stop':
      return patch(state, workerId, {
        status: activeStatus(slot), question: undefined,
        ...(limits(state, Date.now()).signal === 'red' ? { paused: true, lastEvent: { kind: 'paused' } } : { lastEvent: { kind: 'turn' } }),
      });
```

After this step `grep -n "vazio\|trabalhando\|esperando_voce\|aguardando_review\|iniciando\|enviado\|aberto\|encerrado\|pausado" src/orchestrator.ts` prints nothing.

- [ ] **Step 6: Edit `src/server.ts`**

Lines 90, 243, 487: `'vazio'` → `'empty'`. Line 327: `slotOf(workerId)?.status === 'review'`. `SLOT_EMPTY_MESSAGE` unchanged.

- [ ] **Step 7: Edit `src/state-store.ts`**

Imports:

```ts
import { initialState, SIGNALS, STATUSES } from './orchestrator.js';
import type { Signal, Slot, SlotEvent, SlotEventKind, State, Status, UsageRule, UsageSample } from './types.js';
```

Add after `isRule`:

```ts
// Files written before the status keys were neutral carry the Portuguese words and a lastEvent sentence.
const LEGACY_STATUS: Record<string, Status> = { vazio: 'empty', trabalhando: 'working', esperando_voce: 'waiting', aguardando_review: 'review' };
const EVENT_KINDS: readonly SlotEventKind[] = ['starting', 'prompt', 'tool', 'waiting', 'pr', 'paused', 'turn'];

const isSlotEvent = (value: unknown): value is SlotEvent =>
  typeof value === 'object' && value !== null && EVENT_KINDS.includes((value as SlotEvent).kind)
  && ((value as SlotEvent).detail === undefined || typeof (value as SlotEvent).detail === 'string');

function statusOf(raw: unknown): Status | undefined {
  if (STATUSES.includes(raw as Status)) return raw as Status;
  return typeof raw === 'string' && Object.hasOwn(LEGACY_STATUS, raw) ? LEGACY_STATUS[raw] : undefined; // hasOwn: "constructor" is not a status
}

// Unknown status: nothing to trust beyond the id (boot gives every occupied slot as dead anyway). A sentence or a bad object is not a lastEvent.
function normalizeSlot(slot: Slot): Slot {
  const status = statusOf(slot.status);
  if (status === undefined) return { id: slot.id, status: 'empty' };
  const { lastEvent, ...rest } = slot;
  return { ...rest, status, ...(isSlotEvent(lastEvent) ? { lastEvent } : {}) };
}
```

In `normalize`, add to the returned object after `...rest,`:

```ts
    slots: parsed.slots.map(normalizeSlot),
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 256 tests PASS (`state-store` 9, `orchestrator` 59, `server` 15, `log` 11). `grep -rn "vazio\|trabalhando\|esperando_voce\|aguardando_review" src/orchestrator.ts src/log.ts src/state-store.ts` prints only the `LEGACY_STATUS` line.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/state-store.ts src/server.ts src/log.ts test/state-store.test.ts test/orchestrator.test.ts test/server.test.ts test/log.test.ts
git commit -m "refactor(state): neutral slot status keys and a structured lastEvent; legacy state.json mapped on load"
```

---

### Task 4: Server and boot — `systemLanguage`, effective language on `/setup` and the status line, `bootHive(repo, { locale })`, dialog title (TDD)

**Files:**
- Modify: `src/types.ts`, `src/rate-limits.ts`, `src/server.ts`, `src/hive.ts`, `src/main.ts`
- Test: `test/rate-limits.test.ts`, `test/setup.test.ts`, `test/hive.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `SetupBody.language?: Language`; `SetupInfo.language: Language` (effective: the config's, else the system's).
- Produces (in `src/rate-limits.ts`): `windowLabel(key: string, language: Language): string`; `formatRateLimits(limits: RateLimits, language: Language): string` — `pt`: `sessão` / `semana` (unchanged), `en`: `session` / `week`; `seven_day_<x>` → `semana <x>` / `week <x>`; other keys read as their key with spaces in both.
- Produces (in `src/server.ts`): `ServerDeps.systemLanguage?: Language` (default `'en'`); `effectiveLanguage(): Language` = `(live?.runtime.config ?? deps.setupFallback?.config)?.language ?? systemLanguage`; `GET /setup` adds `language`; `POST /hooks/status` answers `formatRateLimits(rateLimits, effectiveLanguage())`; `saveSetup` passes `language: body.language ?? current?.language` to `parseConfig` (a form save always sends it; an API caller that omits it keeps the saved one; an invalid one is 400 naming the field); route `GET /ui/i18n.js`.
- Produces (in `src/hive.ts`): `export interface BootOptions { locale?: string }`; `bootHive(repo, options = {})` — `language = options.locale === undefined ? systemLanguage() : languageFrom(options.locale)`, passed as `systemLanguage` to `createServer` in both hive and setup mode.
- Produces (in `src/main.ts`): `pickRepo(language)` with `DIALOG_TITLE: Record<Language, string>`; `bootHive(repo, { locale: app.getLocale() })`. `src/run.ts` does not change (no locale → `systemLanguage()`).
- Consumed by: Task 6 (`setupInfo.language`, `/ui/i18n.js`).

- [ ] **Step 1: Write the failing tests**

`test/rate-limits.test.ts` — change the existing `formatRateLimits is the status line…` test to pass `'pt'` everywhere (`formatRateLimits(PARSED, 'pt')`, `formatRateLimits(fable, 'pt')`, `windowLabel('five_hour', 'pt')` … `windowLabel('constructor', 'pt')`), keeping every expected value. Append:

```ts
test('formatRateLimits and windowLabel in English: session / week, the weekly prefix translated, other keys as they are', () => {
  assert.equal(formatRateLimits(PARSED, 'en'), 'session 23% · week 41%');
  const fable: RateLimits = { at: PARSED.at, windows: { ...PARSED.windows, seven_day_fable: { usedPercent: 99.5, resetsAt: PARSED.at } } };
  assert.equal(formatRateLimits(fable, 'en'), 'session 23% · week 41% · week fable 100%');
  assert.equal(windowLabel('seven_day_opus', 'en'), 'week opus');
  assert.equal(windowLabel('spend_limit', 'en'), 'spend limit');
  assert.equal(windowLabel('constructor', 'en'), 'constructor');
});
```

`test/setup.test.ts` — imports: add `Language` to the types import (`import type { Config, Language, SetupBody, SetupInfo, State } from '../src/types.js';`). Change `start`:

```ts
async function start(t: TestContext, resolveDelayMs = 0, systemLanguage?: Language): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-setup-'));
  const { factory, configs } = fakeBoardFactory(resolveDelayMs);
  const server = createServer({ repo, boardFactory: factory, systemLanguage });
```

Line 51 becomes:

```ts
  assert.deepEqual(await json<SetupInfo>(fetch(`${base}/setup`)), { configured: false, repo, language: 'en' }); // no systemLanguage injected: en
```

Hoist the status-line fixtures out of the `POST /hooks/status answers the limits line…` test to module level (above it), and make that test use them; its expected line becomes English because `start(t)` injects no language:

```ts
const STATUS_PAYLOAD = {
  model: { id: 'claude-opus' }, // the rest of the status line JSON rides along and is ignored
  rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1759744800 }, seven_day: { used_percentage: 41, resets_at: 1760263200 } },
};
const postStatus = (base: string, body: unknown, worker?: string): Promise<Response> =>
  fetch(`${base}/hooks/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(worker ? { 'x-hive-worker': worker } : {}) },
    body: JSON.stringify(body),
  });
```

```ts
  assert.equal(await ok.text(), 'session 23% · week 41%'); // no systemLanguage injected: en
```

Append two tests:

```ts
test('GET /setup carries the effective language: the system one until a save sets it, then the file; an omitted key keeps it; a bad value is 400', async (t) => {
  const { base, repo } = await start(t, 0, 'pt');
  const language = async (): Promise<Language> => (await json<SetupInfo>(fetch(`${base}/setup`))).language;
  const saved = async (): Promise<Config> => JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(await language(), 'pt');
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal(await language(), 'pt', 'no language in the body: still the system one');
  assert.equal('language' in (await saved()), false, 'and the file has no language key');
  assert.equal((await postSetup(base, { ...BODY, language: 'en' })).status, 200);
  assert.equal(await language(), 'en');
  assert.equal((await saved()).language, 'en');
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal(await language(), 'en', 'an API caller that omits it keeps the saved one');
  const bad = await postSetup(base, { ...BODY, language: 'fr' });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"language" must be one of: pt, en/);
  assert.equal((await saved()).language, 'en', 'nothing written');
});

test('POST /hooks/status answers in the effective language: the system one first, the saved one after', async (t) => {
  const { base } = await start(t, 0, 'pt');
  assert.equal(await (await postStatus(base, STATUS_PAYLOAD, 'ghost')).text(), 'sessão 23% · semana 41%', 'setup mode: the system language');
  assert.equal((await postSetup(base, { ...BODY, language: 'en' })).status, 200);
  assert.equal(await (await postStatus(base, STATUS_PAYLOAD, 'ghost')).text(), 'session 23% · week 41%');
});
```

`test/hive.test.ts` — append:

```ts
const setupInfo = async (port: number): Promise<SetupInfo> => (await fetch(`http://127.0.0.1:${port}/setup`)).json() as Promise<SetupInfo>;

test('bootHive turns the locale into the system language: pt-BR without a config language gives pt, the config wins when set, and setup mode carries it too', async (t) => {
  const pt = await bootHive(await repoWithConfig({}), { locale: 'pt-BR' });
  t.after(() => pt.server.close());
  assert.equal((await setupInfo(pt.port)).language, 'pt');
  const en = await bootHive(await repoWithConfig({ language: 'en' }), { locale: 'pt-BR' });
  t.after(() => en.server.close());
  assert.equal((await setupInfo(en.port)).language, 'en', 'the config wins over the system');
  const broken = await repoWithConfig({});
  await rm(join(broken, 'board.md')); // setup fallback: port 0 comes from the saved config, so no fixed port is touched
  const setup = await bootHive(broken, { locale: 'en-US' });
  t.after(() => setup.server.close());
  assert.equal((await setupInfo(setup.port)).language, 'en');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build errors — `Expected 1 arguments, but got 2` on `formatRateLimits`, `'systemLanguage' does not exist in type 'ServerDeps'`, `Expected 1 arguments, but got 2` on `bootHive`.

- [ ] **Step 3: Edit `src/types.ts`**

In `SetupInfo`, add after `error?: string;`:

```ts
  /** Effective UI language: the config's when set, else the system's. Read by app.ts before any render. */
  language: Language;
```

In `SetupBody`, add after `epics?: EpicsMode;`:

```ts
  /** The form always sends it; an API caller that omits it keeps the current one (or the system's on first setup). */
  language?: Language;
```

- [ ] **Step 4: Edit `src/rate-limits.ts`**

```ts
import type { Language, RateLimits, RateLimitWindow } from './types.js';
…
const LABELS: Record<Language, Record<string, string>> = {
  pt: { five_hour: 'sessão', seven_day: 'semana' },
  en: { five_hour: 'session', seven_day: 'week' },
};
…
/** five_hour → sessão / session, seven_day → semana / week, seven_day_<x> → semana <x> / week <x>; anything else reads as its key with spaces. */
export function windowLabel(key: string, language: Language): string {
  const labels = LABELS[language];
  if (Object.hasOwn(labels, key)) return labels[key]; // hasOwn: "constructor" must not resolve to Object's
  if (key.startsWith(WEEKLY_PREFIX)) return `${labels.seven_day} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

/** The line the worker's status line shows: "sessão 23% · semana 41%" or "session 23% · week 41%". */
export function formatRateLimits(limits: RateLimits, language: Language): string {
  return Object.entries(limits.windows)
    .map(([key, window]) => `${windowLabel(key, language)} ${Math.round(window.usedPercent)}%`)
    .join(' · ');
}
```

- [ ] **Step 5: Edit `src/server.ts`**

Types import: add `Language` to the `./types.js` list. In `ServerDeps`, add after `log?: Logger; …`:

```ts
  systemLanguage?: Language; // from the locale the boot saw; default en. The config's language wins when set
```

In `createServer`, add after `const log = …`:

```ts
  const systemLanguage = deps.systemLanguage ?? 'en';
```

Add after `slotOf`:

```ts
  // What the UI and the status line speak: the saved config's language, else the system's. Setup mode reads the fallback config too.
  const effectiveLanguage = (): Language => (live?.runtime.config ?? deps.setupFallback?.config)?.language ?? systemLanguage;
```

`POST /hooks/status`:

```ts
    res.send(formatRateLimits(rateLimits, effectiveLanguage())); // from the payload, not the State: an unknown worker gets the line and the reducer ignores it
```

`GET /setup`:

```ts
  app.get('/setup', (_req: Request, res: Response) => {
    const language = effectiveLanguage();
    const info: SetupInfo = live
      ? { configured: true, repo, config: live.runtime.config, language }
      : { configured: false, repo, ...deps.setupFallback, language };
    res.json(info);
  });
```

`saveSetup`'s `parseConfig` call, after `logLevel: current?.logLevel, …`:

```ts
        language: body.language ?? current?.language, // the form always sends it; an API caller that omits it keeps the saved one
```

Routes, after `/ui/highlight.js`:

```ts
  app.get('/ui/i18n.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'i18n.js')));
```

- [ ] **Step 6: Edit `src/hive.ts`**

```ts
import { languageFrom, systemLanguage } from './language.js';
…
import type { Language } from './types.js';

export interface BootOptions {
  locale?: string; // Electron's app.getLocale(); absent (run.js) → the Node process locale
}

export async function bootHive(repo: string, options: BootOptions = {}): Promise<BootedHive> {
  const language = options.locale === undefined ? systemLanguage() : languageFrom(options.locale);
  const log = createLogger(join(repo, HIVE_DIR)); // …
  …
  if (!config) return bootSetupMode(repo, log, language);
  …
    return bootSetupMode(repo, log, language, { config, error });
  …
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved, log, systemLanguage: language });
```

```ts
async function bootSetupMode(repo: string, log: Logger, language: Language, setupFallback?: ServerDeps['setupFallback']): Promise<BootedHive> {
  log.info(`boot repo=${repo} mode=setup reason=${setupFallback?.error ?? 'no hive.config.json'}`);
  const server = createServer({ repo, setupFallback, log, systemLanguage: language });
```

- [ ] **Step 7: Edit `src/main.ts`**

```ts
import { bootHive } from './hive.js';
import { languageFrom } from './language.js';
import type { Language } from './types.js';

const APP_NAME = 'Agent Hive';
// Shown before any config exists, so it follows the system, not the file.
const DIALOG_TITLE: Record<Language, string> = {
  pt: 'Escolha o repositório com hive.config.json',
  en: 'Choose the repository with hive.config.json',
};
```

```ts
async function pickRepo(language: Language): Promise<string | undefined> {
  …
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: DIALOG_TITLE[language],
```

In `app.whenReady().then(async () => {`:

```ts
  setDockIcon();
  const locale = app.getLocale(); // valid only after ready
  const repo = await pickRepo(languageFrom(locale));
  …
  const { port, server } = await bootHive(repo, { locale });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 260 tests PASS (`rate-limits` 8, `setup` 28, `hive` 6). `test/hive-cli.test.ts` is unaffected (it does not reach `bootHive`).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/rate-limits.ts src/server.ts src/hive.ts src/main.ts test/rate-limits.test.ts test/setup.test.ts test/hive.test.ts
git commit -m "feat(server): effective language on GET /setup, POST /setup and the worker status line; locale from Electron or the process"
```

---

### Task 5: `src/ui/i18n.ts` — the dictionary, `t`, `statusText`, `slotEventText`, `applyTranslations` (TDD)

**Files:**
- Create: `src/ui/i18n.ts`, `test/i18n.test.ts`

**Interfaces:**
- Produces (in `src/ui/i18n.ts`):
  - `export type MessageKey = keyof typeof en;` `export const MESSAGES: Record<Language, Record<MessageKey, string>>` — `en` is the reference literal, `pt: Record<MessageKey, string>` (so `tsc` rejects a missing or extra key before the parity test runs).
  - `export const LOCALE: Record<Language, string> = { pt: 'pt-BR', en: 'en-US' };`
  - `export function setLanguage(language: Language): void` (module state, initial `'en'`).
  - `export function t(key: MessageKey, vars?: Record<string, string | number>): string` — the text for the current language; with `vars`, every `{name}` whose name is an own key of `vars` is replaced; without `vars` nothing is touched (the prompt placeholder and hint contain literal `{id}` / `{number}`).
  - `export function statusText(status: Status): string`; `export function slotEventText(event: SlotEvent): string` — `tool` returns `detail` as is (already the text the reducer built, escaped by the caller), `waiting` prefixes `detail`, the others are fixed sentences.
  - `export function applyTranslations(): void` — `[data-i18n]` → `textContent`, `[data-i18n-html]` → `innerHTML` (dictionary text, only the hints with `<code>`), `[data-i18n-placeholder]` → `placeholder`; then `document.documentElement.lang = LOCALE[current]`. Touches `document` only when called, so node imports the module fine.
- Consumed by: Task 6 (`app.ts`, `limits.ts`, `index.html`).

- [ ] **Step 1: Write the failing tests — `test/i18n.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALE, MESSAGES, setLanguage, slotEventText, statusText, t } from '../src/ui/i18n.js';

const INDEX_HTML = new URL('../../src/ui/index.html', import.meta.url); // dist/test → repo root

test('pt and en have exactly the same keys and no empty text', () => {
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.pt).sort(), en);
  assert.ok(en.length > 60, `only ${en.length} keys`);
  for (const language of ['pt', 'en'] as const) {
    for (const [key, text] of Object.entries(MESSAGES[language])) assert.ok(text.trim().length > 0, `${language}.${key} is empty`);
  }
  assert.deepEqual(LOCALE, { pt: 'pt-BR', en: 'en-US' });
});

test('every data-i18n key in index.html exists in the dictionary', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-html|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40, `only ${keys.length} keys in the HTML`);
  const missing = keys.filter((key) => !Object.hasOwn(MESSAGES.en, key));
  assert.deepEqual(missing, []);
});

test('statusText and slotEventText follow the language: tool shows the detail, waiting prefixes it', () => {
  setLanguage('pt');
  assert.equal(statusText('empty'), 'vazio');
  assert.equal(statusText('waiting'), 'esperando você');
  assert.equal(statusText('review'), 'aguardando review');
  assert.equal(slotEventText({ kind: 'starting' }), 'iniciando');
  assert.equal(slotEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(slotEventText({ kind: 'waiting', detail: 'permission_prompt' }), 'aguardando: permission_prompt');
  assert.equal(slotEventText({ kind: 'paused' }), 'pausado: sinal red');
  assert.equal(slotEventText({ kind: 'turn' }), 'turno encerrado');
  setLanguage('en');
  assert.equal(statusText('working'), 'working');
  assert.equal(statusText('waiting'), 'waiting for you');
  assert.equal(slotEventText({ kind: 'prompt' }), 'prompt sent');
  assert.equal(slotEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(slotEventText({ kind: 'waiting', detail: 'idle_prompt' }), 'waiting: idle_prompt');
  assert.equal(slotEventText({ kind: 'pr' }), 'PR open');
  assert.equal(slotEventText({ kind: 'tool' }), '', 'a tool event without a summary shows nothing');
});

test('t fills {placeholders} from vars and leaves the text alone otherwise', () => {
  setLanguage('en');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 active workers');
  assert.equal(t('setup.rules.error', { n: 3 }), 'tier 3: enter max. workers or a signal');
  assert.equal(t('queue.blockedBy', { ids: '4, 5' }), 'blocked by 4, 5');
  assert.match(t('setup.promptPlaceholder'), /\{number\}: \{title\}/, 'no vars: literal braces stay');
  assert.equal(t('limits.at', { other: 'x' }), 'at {time}', 'an unknown placeholder stays');
  setLanguage('pt');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 workers ativos');
  assert.equal(t('setup.rules.error', { n: 3 }), 'faixa 3: informe máx. workers ou sinal');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Cannot find module '../src/ui/i18n.js'`. (The `index.html` test also fails until Task 6 adds the keys: it asserts `keys.length > 40`. That is expected; see Step 4.)

- [ ] **Step 3: Create `src/ui/i18n.ts`**

The `pt` column is the text the UI shows today, byte for byte. `en` is the reference object.

```ts
// The only place UI text lives. Served as /ui/i18n.js; no DOM at import time, so node:test covers t / statusText / slotEventText.
import type { Language, SlotEvent, SlotEventKind, Status } from '../types.js';

const en = {
  'header.activeWorkers': '{active}/{max} active workers',
  'maxWorkers': 'max. workers',
  'header.refresh': 'refresh board',
  'header.configure': 'configure',
  'signal.yellow': 'no new jobs',
  'signal.red': 'manual mode',
  'usage.day': '{n}/day',
  'usage.over': 'over budget',
  'window.session': 'session',
  'window.week': 'week',
  'limits.resets': 'resets {time}',
  'limits.at': 'at {time}',
  'status.empty': 'empty',
  'status.working': 'working',
  'status.waiting': 'waiting for you',
  'status.review': 'awaiting review',
  'event.starting': 'starting',
  'event.prompt': 'prompt sent',
  'event.waiting': 'waiting: {detail}',
  'event.pr': 'PR open',
  'event.paused': 'paused: red signal',
  'event.turn': 'turn ended',
  'card.draining': 'draining',
  'card.paused': 'paused',
  'detail.title': 'detail',
  'detail.pending': 'pending:',
  'detail.focus': 'open terminal',
  'detail.close': 'close',
  'queue.title': 'queue',
  'queue.empty': 'empty',
  'queue.blockedBy': 'blocked by {ids}',
  'confirm.kill': 'Kill this worker? The task goes back to the queue.',
  'error.disconnected': 'connection to the Agent Hive lost; reconnecting…',
  'notice.restartPort': 'restart the Hive to use port {port}',
  'setup.title': 'configuration',
  'setup.tab.board': 'board',
  'setup.tab.general': 'general',
  'setup.tab.limits': 'limits',
  'setup.boardType': 'board type',
  'setup.boardType.github': 'GitHub Project',
  'setup.boardType.markdown': 'markdown file in the repo',
  'setup.owner': 'owner',
  'setup.load': 'load',
  'setup.project': 'project',
  'setup.projectPlaceholder': "load the owner's projects",
  'setup.columnQueue': 'queue column',
  'setup.columnWorking': 'in-progress column',
  'setup.columnReview': 'review column',
  'setup.epics': 'epics (issues with sub-issues)',
  'setup.epics.ignore': 'ignore: only the sub-issues are queued',
  'setup.epics.queue': 'queue once every sub-issue is closed',
  'setup.markdownPath': 'path (relative to the repo or absolute)',
  'setup.markdownHint': 'table <code>| id | título | status |</code>; if the file does not exist, it is created on save. "load" lists the statuses already used in the file.',
  'setup.markdownFound': 'statuses found: {list} — click the field to choose.',
  'setup.workers': 'where the workers run',
  'setup.workers.embedded': 'embedded (tmux session; terminal through the card button)',
  'setup.workers.iterm': 'iTerm2 tabs (macOS)',
  'setup.language': 'language',
  'setup.promptTemplate': 'worker prompt',
  'setup.promptPlaceholder': 'empty = default: Task #{number}: {title}, the issue body and the instruction to open a PR with gh pr create',
  'setup.promptHint': 'placeholders: <code>{id}</code> <code>{title}</code> <code>{body}</code> <code>{url}</code> (<code>{number}</code> is an alias of <code>{id}</code>) — e.g. <code>/ship #{id}</code>. Empty keeps the current one. On markdown, <code>{body}</code> is empty and <code>{url}</code> is the file path. Permissions and questions are answered in the worker\'s terminal (<code>terminal</code> button on the card). Embedded mode needs <code>tmux</code> (<code>brew install tmux</code> / <code>apt install tmux</code>).',
  'setup.budgetHour': 'tokens per hour',
  'setup.budgetDay': 'tokens per day',
  'setup.budgetHint': 'hourly and daily totals; past a limit no new job opens (the running ones finish). Empty = no limit.',
  'setup.rules.percent': '% of the budget',
  'setup.rules.signal': 'signal',
  'setup.rules.add': 'add tier',
  'setup.rules.remove': 'remove',
  'setup.rules.error': 'tier {n}: enter max. workers or a signal',
  'setup.rulesHint': 'cumulative tiers: past a tier, every earlier one still applies (the worst signal and the lowest cap). The manual signal of the dashboard wins when it is stricter.',
  'setup.save': 'save',
  'setup.cancel': 'cancel',
  'setup.error.owner': 'enter the owner (@me, a user or an org)',
  'setup.error.noProjects': 'no open project in {owner}',
  'setup.error.path': 'enter the file path',
  'setup.error.project': 'choose a project',
};

export type MessageKey = keyof typeof en;

const pt: Record<MessageKey, string> = {
  'header.activeWorkers': '{active}/{max} workers ativos',
  'maxWorkers': 'máx. workers',
  'header.refresh': 'atualizar board',
  'header.configure': 'configurar',
  'signal.yellow': 'sem jobs novos',
  'signal.red': 'modo manual',
  'usage.day': '{n}/dia',
  'usage.over': 'sem orçamento',
  'window.session': 'sessão',
  'window.week': 'semana',
  'limits.resets': 'reseta {time}',
  'limits.at': 'às {time}',
  'status.empty': 'vazio',
  'status.working': 'trabalhando',
  'status.waiting': 'esperando você',
  'status.review': 'aguardando review',
  'event.starting': 'iniciando',
  'event.prompt': 'prompt enviado',
  'event.waiting': 'aguardando: {detail}',
  'event.pr': 'PR aberto',
  'event.paused': 'pausado: sinal red',
  'event.turn': 'turno encerrado',
  'card.draining': 'drenando',
  'card.paused': 'pausado',
  'detail.title': 'detalhe',
  'detail.pending': 'pendente:',
  'detail.focus': 'ir pro terminal',
  'detail.close': 'fechar',
  'queue.title': 'fila',
  'queue.empty': 'vazia',
  'queue.blockedBy': 'bloqueada por {ids}',
  'confirm.kill': 'Matar esse worker? A task volta pra fila.',
  'error.disconnected': 'conexão com o Agent Hive perdida; reconectando…',
  'notice.restartPort': 'reinicie o Hive pra usar a porta {port}',
  'setup.title': 'configuração',
  'setup.tab.board': 'board',
  'setup.tab.general': 'geral',
  'setup.tab.limits': 'limites',
  'setup.boardType': 'tipo de board',
  'setup.boardType.github': 'GitHub Project',
  'setup.boardType.markdown': 'arquivo markdown no repo',
  'setup.owner': 'owner',
  'setup.load': 'carregar',
  'setup.project': 'project',
  'setup.projectPlaceholder': 'carregue os projects do owner',
  'setup.columnQueue': 'coluna da fila',
  'setup.columnWorking': 'coluna em andamento',
  'setup.columnReview': 'coluna em review',
  'setup.epics': 'épicos (issues com sub-issues)',
  'setup.epics.ignore': 'ignorar: só as sub-issues entram na fila',
  'setup.epics.queue': 'enfileirar quando todas as sub-issues fecharem',
  'setup.markdownPath': 'caminho (relativo ao repo ou absoluto)',
  'setup.markdownHint': 'tabela <code>| id | título | status |</code>; se o arquivo não existe, é criado ao salvar. "carregar" lista os status já usados no arquivo.',
  'setup.markdownFound': 'status encontrados: {list} — clique no campo para escolher.',
  'setup.workers': 'onde os workers rodam',
  'setup.workers.embedded': 'embutidos (sessão tmux; terminal pelo botão do card)',
  'setup.workers.iterm': 'tabs do iTerm2 (macOS)',
  'setup.language': 'idioma',
  'setup.promptTemplate': 'prompt do worker',
  'setup.promptPlaceholder': 'vazio = padrão: Task #{number}: {title}, o body do issue e a instrução de abrir PR com gh pr create',
  'setup.promptHint': 'placeholders: <code>{id}</code> <code>{title}</code> <code>{body}</code> <code>{url}</code> (<code>{number}</code> é sinônimo de <code>{id}</code>) — ex.: <code>/ship #{id}</code>. Vazio mantém o atual. No markdown, <code>{body}</code> é vazio e <code>{url}</code> é o caminho do arquivo. Permissões e perguntas são respondidas no terminal do worker (botão <code>terminal</code> no card). O modo embutido precisa do <code>tmux</code> (<code>brew install tmux</code> / <code>apt install tmux</code>).',
  'setup.budgetHour': 'tokens por hora',
  'setup.budgetDay': 'tokens por dia',
  'setup.budgetHint': 'totais por hora e por dia; ao estourar, nenhum job novo abre (os que estão rodando terminam). Vazio = sem limite.',
  'setup.rules.percent': '% do orçamento',
  'setup.rules.signal': 'sinal',
  'setup.rules.add': 'adicionar faixa',
  'setup.rules.remove': 'remover',
  'setup.rules.error': 'faixa {n}: informe máx. workers ou sinal',
  'setup.rulesHint': 'faixas cumulativas: ao passar de uma faixa, valem todas as anteriores (o pior sinal e o menor teto). O sinal manual do dashboard vence quando é mais restritivo.',
  'setup.save': 'salvar',
  'setup.cancel': 'cancelar',
  'setup.error.owner': 'informe o owner (@me, usuário ou org)',
  'setup.error.noProjects': 'nenhum project aberto em {owner}',
  'setup.error.path': 'informe o caminho do arquivo',
  'setup.error.project': 'escolha um project',
};

export const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, pt };
export const LOCALE: Record<Language, string> = { pt: 'pt-BR', en: 'en-US' };
const PLACEHOLDER = /\{(\w+)\}/g;
const STATUS_KEY: Record<Status, MessageKey> = { empty: 'status.empty', working: 'status.working', waiting: 'status.waiting', review: 'status.review' };
const EVENT_KEY: Record<Exclude<SlotEventKind, 'tool'>, MessageKey> = {
  starting: 'event.starting', prompt: 'event.prompt', waiting: 'event.waiting', pr: 'event.pr', paused: 'event.paused', turn: 'event.turn',
};

let current: Language = 'en';

export function setLanguage(language: Language): void {
  current = language;
}

/** The text for `key` in the current language; `{name}` placeholders are filled from `vars` and left alone when there is none. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = MESSAGES[current][key];
  if (!vars) return text; // the prompt hint carries literal {id} / {number}: untouched
  return text.replace(PLACEHOLDER, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}

export const statusText = (status: Status): string => t(STATUS_KEY[status]);

/** The card's last-event line. `tool` is already the text the reducer built (the caller escapes it); `waiting` names the notification kind. */
export function slotEventText(event: SlotEvent): string {
  if (event.kind === 'tool') return event.detail ?? '';
  return t(EVENT_KEY[event.kind], { detail: event.detail ?? '' });
}

/** Static text from the keys in the HTML. innerHTML only for the hints with <code>: the dictionary is code, not input. */
export function applyTranslations(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as MessageKey);
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml as MessageKey);
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder as MessageKey);
  document.documentElement.lang = LOCALE[current];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 263 tests PASS and 1 FAIL — `every data-i18n key in index.html…` fails on `keys.length > 40` (the HTML has no keys yet). This is the one intentional red carried into Task 6; the commit below is allowed because the failing test documents the next task, not a bug. If a fully green commit is preferred, squash Tasks 5 and 6 into one commit after Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/ui/i18n.ts test/i18n.test.ts
git commit -m "feat(ui): i18n dictionary with pt and en, t, statusText, slotEventText and applyTranslations"
```

---

### Task 6: `index.html`, `app.ts`, `limits.ts` — keys only, language field, `LOCALE` for dates; manual verification

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`, `src/ui/limits.ts`

**Interfaces:**
- `index.html`: every visible text becomes a key; text inside a `<label>` that also holds a control goes in a `<span data-i18n>` so the control survives `textContent`; the markdown hint keeps `#md-found` outside the translated span; `#summary` starts empty (render fills it); new `<label><span data-i18n="setup.language"></span><select id="language"><option value="pt">português</option><option value="en">English</option></select></label>` on the general tab (language names untranslated); CSS `--vazio` → `--empty`, `--trabalhando` → `--working`, `--esperando` → `--waiting`; `.card.trabalhando` → `.card.working`, `.card.aguardando_review` → `.card.review`, `.card.esperando_voce` → `.card.waiting`; `<html lang="en">` (overwritten by `applyTranslations`).
- `app.ts`: `applyLanguage(language)` = `setLanguage` + `applyTranslations`, called right after the first `GET /setup` in `init` (before `openSetup` / `connect`) and right after the re-read in `saveSetup` (before `closeSetup`, followed by `render()` so the dashboard already on screen switches); `STATUS_LABEL` → `statusText`, `slot.lastEvent` → `slotEventText`, `SIGNAL_HINT` / `WINDOW_LABEL` and every literal listed below through `t`; `locale()` = `LOCALE[setupInfo?.language ?? 'en']` for `clock`, `toLocaleString`, `toLocaleTimeString`; `openSetup` preselects `#language` with `setupInfo.language`; `saveSetup` sends `language`.
- `limits.ts`: `remover` → `t('setup.rules.remove')`, the tier error → `t('setup.rules.error', { n: index + 1 })`.
- Untranslated on purpose (identical in both languages): `Agent Hive`, `green` / `yellow` / `red`, `terminal`, `kill`, `issue`, `PR:`, `worktree:`, `branch:`, `board:`, `tokens`, `/h`, `min` / `h`, `—`, `GitHub`.

- [ ] **Step 1: Edit `src/ui/index.html`**

`<html lang="en">`. In `<style>`: rename the three variables and their uses (`--vazio` at `:root` and `.card`; `--trabalhando` at `:root`, `button.active[data-signal=green]`, `.card.working`, `#output .add`; `--esperando` at `:root`, `button.active[data-signal=yellow]`, `#notice`, `.card.waiting`) and the three card rules:

```css
    --empty: #3a4250; --working: #2e9e5b; --waiting: #e0b52a; --review: #3b82f6; --danger: #d9534f;
…
  button.active[data-signal=green] { border-color: var(--working); color: var(--working); }
  button.active[data-signal=yellow] { border-color: var(--waiting); color: var(--waiting); }
…
  #notice { display: none; background: #3a3110; color: var(--waiting); padding: 8px 20px; }
…
  .card { … border-left: 6px solid var(--empty); … }
  .card.working { border-left-color: var(--working); }
  .card.review { border-left-color: var(--review); }
  .card.waiting { border-left-color: var(--waiting); animation: blink 1s ease-in-out infinite; }
…
  #output .add { color: var(--working); }
```

Replace the whole `<body>` (scripts included) with:

```html
<body>
<header>
  <h1>Agent Hive</h1>
  <span id="summary" class="dash"></span>
  <label class="dash"><span data-i18n="maxWorkers"></span> <input id="max" type="number" min="0" step="1"></label>
  <span id="signal" class="dash">
    <button type="button" data-signal="green">green</button>
    <button type="button" data-signal="yellow">yellow</button>
    <button type="button" data-signal="red">red</button>
    <span id="signal-hint"></span>
  </span>
  <span id="usage" class="dash"></span>
  <span id="limits" class="dash"></span>
  <span id="quota" class="dash"></span>
  <button type="button" id="refresh" class="dash" data-i18n="header.refresh"></button>
  <button type="button" id="configure" data-i18n="header.configure"></button>
  <span id="polled" class="dash" style="color: var(--muted); margin-left: auto;"></span>
</header>
<div id="error"></div>
<div id="notice"></div>
<form id="setup">
  <h2 data-i18n="setup.title"></h2>
  <div class="tabs">
    <nav id="setup-tabs">
      <button type="button" data-tab="board" aria-pressed="true" data-i18n="setup.tab.board"></button>
      <button type="button" data-tab="geral" aria-pressed="false" data-i18n="setup.tab.general"></button>
      <button type="button" data-tab="limites" aria-pressed="false" data-i18n="setup.tab.limits"></button>
    </nav>
    <div class="panels">
      <section data-panel="board">
        <label><span data-i18n="setup.boardType"></span>
          <select id="board-type">
            <option value="github" data-i18n="setup.boardType.github"></option>
            <option value="markdown" data-i18n="setup.boardType.markdown"></option>
          </select>
        </label>
        <fieldset id="github-fields">
          <div class="row">
            <label><span data-i18n="setup.owner"></span> <input id="owner" type="text" value="@me" required></label>
            <button type="button" id="load-projects" data-i18n="setup.load"></button>
          </div>
          <label><span data-i18n="setup.project"></span> <select id="project" required><option value="" data-i18n="setup.projectPlaceholder"></option></select></label>
          <label><span data-i18n="setup.columnQueue"></span> <select id="col-queue" required></select></label>
          <label><span data-i18n="setup.columnWorking"></span> <select id="col-working" required></select></label>
          <label><span data-i18n="setup.columnReview"></span> <select id="col-review" required></select></label>
          <label><span data-i18n="setup.epics"></span>
            <select id="epics">
              <option value="ignore" data-i18n="setup.epics.ignore"></option>
              <option value="queue" data-i18n="setup.epics.queue"></option>
            </select>
          </label>
        </fieldset>
        <fieldset id="markdown-fields" disabled>
          <div class="row">
            <label><span data-i18n="setup.markdownPath"></span> <input id="md-path" type="text" value="board.md" required></label>
            <button type="button" id="load-columns" data-i18n="setup.load"></button>
          </div>
          <div class="hint"><span data-i18n-html="setup.markdownHint"></span> <span id="md-found"></span></div>
          <label><span data-i18n="setup.columnQueue"></span> <input id="md-queue" type="text" list="md-options" value="Ready" required></label>
          <label><span data-i18n="setup.columnWorking"></span> <input id="md-working" type="text" list="md-options" value="In progress" required></label>
          <label><span data-i18n="setup.columnReview"></span> <input id="md-review" type="text" list="md-options" value="In review" required></label>
          <datalist id="md-options"></datalist>
        </fieldset>
      </section>
      <section data-panel="geral" hidden>
        <label><span data-i18n="setup.language"></span>
          <select id="language">
            <option value="pt">português</option>
            <option value="en">English</option>
          </select>
        </label>
        <label><span data-i18n="setup.workers"></span>
          <select id="workers-mode">
            <option value="embedded" data-i18n="setup.workers.embedded"></option>
            <option value="iterm" data-i18n="setup.workers.iterm"></option>
          </select>
        </label>
        <label><span data-i18n="setup.promptTemplate"></span> <textarea id="prompt-template" rows="4" spellcheck="false" data-i18n-placeholder="setup.promptPlaceholder"></textarea></label>
        <div class="hint" data-i18n-html="setup.promptHint"></div>
      </section>
      <section data-panel="limites" hidden>
        <div class="row">
          <label><span data-i18n="setup.budgetHour"></span> <input id="budget-hour" type="number" min="0" step="1"></label>
          <label><span data-i18n="setup.budgetDay"></span> <input id="budget-day" type="number" min="0" step="1"></label>
        </div>
        <div class="hint" data-i18n="setup.budgetHint"></div>
        <table id="rules">
          <thead><tr><th data-i18n="setup.rules.percent"></th><th data-i18n="maxWorkers"></th><th data-i18n="setup.rules.signal"></th><th></th></tr></thead>
          <tbody></tbody>
        </table>
        <button type="button" id="add-rule" data-i18n="setup.rules.add"></button>
        <div class="hint" data-i18n="setup.rulesHint"></div>
      </section>
    </div>
  </div>
  <div id="setup-error"></div>
  <div class="actions">
    <button type="submit" id="save" data-i18n="setup.save"></button>
    <button type="button" id="cancel" data-i18n="setup.cancel"></button>
  </div>
</form>
<main>
  <section id="grid"></section>
  <div>
    <aside id="detail">
      <h2 data-i18n="detail.title"></h2>
      <div id="detail-body"></div>
      <div id="output"></div>
      <div class="actions" style="margin-top: 8px; display: flex; gap: 8px;">
        <button type="button" id="focus" data-i18n="detail.focus"></button>
        <button type="button" id="close" data-i18n="detail.close"></button>
      </div>
    </aside>
    <aside id="queue-panel">
      <h2 data-i18n="queue.title"></h2>
      <ol id="queue"></ol>
    </aside>
  </div>
</main>
<script type="module" src="/ui/app.js"></script>
</body>
```

- [ ] **Step 2: Edit `src/ui/limits.ts`**

```ts
import type { Signal, UsageRule } from '../types.js';
import { t } from './i18n.js';
…
    <td><button type="button" class="remove">${t('setup.rules.remove')}</button></td>`;
…
  if (maxWorkers === '' && signal === NO_SIGNAL) throw new Error(t('setup.rules.error', { n: index + 1 }));
```

Update the two doc comments that quote `remover`.

- [ ] **Step 3: Edit `src/ui/app.ts`**

Imports and constants:

```ts
import type {
  BoardConfig, BoardQuota, Budget, EpicsMode, EventsPayload, Language, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult, Signal, Slot,
  State, StatusKey, Task, UsageSample, WorkersMode,
} from '../types.js';
import { esc, renderOutput } from './highlight.js';
import { LOCALE, applyTranslations, type MessageKey, setLanguage, slotEventText, statusText, t } from './i18n.js';
import { addRuleRow, renderRules, usageRulesFromForm } from './limits.js';

const SIGNAL_HINT: Record<Signal, MessageKey | undefined> = { green: undefined, yellow: 'signal.yellow', red: 'signal.red' };
…
// Mirrors src/rate-limits.ts, which cannot be imported here (the served module graph only has app.js); the text comes from the dictionary.
const WINDOW_LABEL: Record<string, MessageKey> = { five_hour: 'window.session', seven_day: 'window.week' };
```

Delete `STATUS_LABEL`. Helpers:

```ts
const locale = (): string => LOCALE[setupInfo?.language ?? 'en'];
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return t(WINDOW_LABEL[key]);
  if (key.startsWith(WEEKLY_PREFIX)) return `${t('window.week')} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

// Static text first, then whatever is already rendered: the caller renders again when there is a State on screen.
function applyLanguage(language: Language): void {
  setLanguage(language);
  applyTranslations();
}
```

Render changes (each replaces the literal on the same line of today's code):

```ts
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${statusText('empty')}</div></div>`;
  const marks = `${slot.draining ? ` · ${t('card.draining')}` : ''}${slot.paused ? ` · ${t('card.paused')}` : ''}`;
…
      <div class="meta">${statusText(slot.status)} · ${elapsed(slot.startedAt)}${marks}${tokens}</div>
…
      <div class="meta">${esc(slot.lastEvent ? slotEventText(slot.lastEvent) : '')}</div>
```

```ts
    slot.question ? `<p>${t('detail.pending')}</p><pre>${esc(slot.question)}</pre>` : '',
```

```ts
    ? `<span class="meta" style="color:var(--muted)"> · ${t('queue.blockedBy', { ids: esc(task.blockedBy.join(', ')) })}</span>`
```

```ts
  const hint = SIGNAL_HINT[signal];
  $('signal-hint').textContent = hint ? t(hint) : '';
```

```ts
    `tokens: ${fmt(hour)}/h`, budget.maxTokensPerHour ? meter(hour, budget.maxTokensPerHour) : '',
    `· ${t('usage.day', { n: fmt(day) })}`, budget.maxTokensPerDay ? meter(day, budget.maxTokensPerDay) : '',
    over ? `· ${t('usage.over')}` : '',
```

```ts
    `${esc(windowLabel(key))} ${Math.round(w.usedPercent)}% ${meter(w.usedPercent, PERCENT_MAX)} ${t('limits.resets', { time: clock(w.resetsAt) })}`);
  el.innerHTML = [...windows, t('limits.at', { time: clock(limits.at) })].join(' · ');
```

```ts
    ? `GitHub ${quota.remaining.toLocaleString(locale())}/${quota.limit.toLocaleString(locale())} · ${t('limits.resets', { time: clock(quota.resetsAt) })}`
```

```ts
  $('summary').textContent = t('header.activeWorkers', { active, max: state.maxConcurrent });
…
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString(locale())}` : '';
…
    || `<li style="list-style:none;color:var(--muted)">${t('queue.empty')}</li>`;
```

```ts
  source.onerror = () => showError(t('error.disconnected'));
```

`loadMarkdownColumns`: `setupError(t('setup.error.path'));` and `$('md-found').textContent = t('setup.markdownFound', { list: options.join(', ') });`. `loadProjects`: `setupError(t('setup.error.owner'));` and `setupError(t('setup.error.noProjects', { owner }));`. `saveSetup`: `setupError(boardType() === 'markdown' ? t('setup.error.path') : t('setup.error.project'));` and `showNotice(result.restartForPort ? t('notice.restartPort', { port: result.restartForPort }) : undefined);`. Kill click: `if (confirm(t('confirm.kill'))) post(…)`.

`openSetup`, after the `epics` line:

```ts
  $<HTMLSelectElement>('language').value = setupInfo?.language ?? 'en'; // the effective one: saving writes it explicitly
```

`saveSetup` body, after `epics: …`:

```ts
      language: $<HTMLSelectElement>('language').value as Language,
```

`saveSetup` after the post:

```ts
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
    applyLanguage(setupInfo.language); // the save may have changed it: static text now, the dashboard on the render below
    closeSetup();
    render(); // no-op without a State; otherwise cards, queue and header switch without waiting for the next event
```

`init`:

```ts
  try {
    setupInfo = await getJson<SetupInfo>('/setup');
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  applyLanguage(setupInfo.language); // before any render: neither the form nor the dashboard ever shows the wrong language
  if (!setupInfo.configured) await openSetup();
  connect();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 264 tests PASS (`i18n` 4 — the `index.html` key test is green now). `grep -n "'vazio'\|trabalhando\|esperando\|aguardando" src/ui/*.ts src/ui/index.html` prints only dictionary lines in `i18n.ts`. `pnpm lint` clean.

- [ ] **Step 5: Manual verification**

1. `LANG=pt_BR.UTF-8 pnpm run:headless /tmp/empty-repo` (no `hive.config.json`), open `http://127.0.0.1:47821`: the form is in Portuguese (`configuração`, `tipo de board`, `salvar`), `html[lang]` is `pt-BR`, the general tab shows `idioma` preselected `português`. Restart with `LANG=en_US.UTF-8`: `configuration`, `board type`, `save`, `language` preselected `English`.
2. `pnpm start -- /path/to/configured-repo` (Electron): the folder dialog title follows the macOS language; the dashboard opens in the config's language or the system's.
3. In a configured repo: `configurar` → general tab → `English` → `salvar`. Without a reload, the header (`0/2 active workers`, `max. workers`, `refresh board`, `configure`), the queue (`queue`, `empty`), the empty cards (`empty`) and the signal hint switch; `hive.config.json` gains `"language": "en"`. Switch back to `português`: `workers ativos`, `fila`, `vazia`.
4. Set the signal to green with a task in the queue: the card shows `working · 0 min`, then `starting`, then a `PreToolUse` shows the command (`Bash: pnpm test`) in both languages; a Notification shows `waiting: permission_prompt` / `aguardando: permission_prompt` and the card is `.waiting` (yellow, blinking); a PR shows `PR open` / `PR aberto` with the `.review` border.
5. Worker status line: after saving `en`, the next spawned worker's tab shows `session 23% · week 41%`; with `pt`, `sessão 23% · semana 41%`.
6. Legacy state: stop the Hive, edit `.hive/state.json` to put `"status": "trabalhando", "lastEvent": "iniciando"` on a slot, start again: no error, the slot is empty after boot.

- [ ] **Step 6: Commit**

```bash
git add src/ui/index.html src/ui/app.ts src/ui/limits.ts
git commit -m "feat(ui): every visible text through the dictionary, language field in the setup form, dates in the chosen locale"
```

---

## Verification

- `NODE_PATH= pnpm test` green: 264 tests (252 before; `language` 2, `i18n` 4, `config` 16, `state-store` 9, `rate-limits` 8, `setup` 28, `hive` 6). `pnpm lint` clean.
- `grep -rn "vazio\|trabalhando\|esperando_voce\|aguardando_review" src/` prints only `LEGACY_STATUS` in `state-store.ts` and the `pt` dictionary in `i18n.ts`; `grep -rn "'vazio'\|iniciando\|prompt enviado\|PR aberto\|turno encerrado\|pausado: sinal" src/orchestrator.ts` prints nothing.
- A `state.json` written by the previous version (Portuguese statuses, `lastEvent` sentences) opens without error and every slot is empty after boot (manual step 6 and the state-store test).
- Changing `language` in the form switches every visible text, including what was already on screen, and the next worker's status line (manual steps 3–5).
- `GET /setup` returns `language` in setup mode, in fallback mode and when configured; `POST /setup` without `language` keeps the saved one; `fr` is 400 naming the field (setup tests).

## Notes

- `t(key, vars?)` is the spec's `t(key)` with an optional placeholder map: `{n}`, `{owner}`, `{active}/{max}`, `{time}`, `{ids}`, `{port}`, `{list}`, `{detail}` keep sentences whole and let the two languages order words differently. Without `vars` nothing is replaced, which is what keeps the literal `{id}` / `{number}` of the prompt placeholder and hint intact through `applyTranslations`.
- `MESSAGES.pt` is typed `Record<MessageKey, string>` against `en`, so `tsc` already refuses a missing or extra key; the parity test is the runtime guard the spec asks for, and the `index.html` key test catches a typo in a `data-i18n` attribute without a DOM.
- `SlotEvent.detail` for `tool` is the reducer's `describeTool` output (worker-derived): `renderCard` keeps wrapping it in `esc()`. `queue.blockedBy` receives already-escaped ids because the result goes into `innerHTML`; every other `t(…, vars)` result lands in `textContent` or carries only numbers / `Date` output.
- The Node-side `Language` mirror is not needed in the UI: `i18n.ts` imports the type only, the languages are the keys of `MESSAGES`, and the `<select>` options are static HTML.
- Deliberate simplifications: no `Accept-Language` sniffing (spec: out); `elapsed` (`12 min`, `1 h 5 min`) and unit suffixes (`/h`, `tokens`) are not translated (identical in both languages); the markdown table header in the hint stays `| id | título | status |` in `en` because it is the file format `newBoardText()` writes; `test/setup.test.ts` line 366 changes to English only because `start(t)` injects no `systemLanguage` and the server default is `en` per spec.
- Task 5 ends with one intentionally red test (`index.html` keys) that Task 6 turns green; squash the two commits if a red intermediate commit is not acceptable on this branch.
