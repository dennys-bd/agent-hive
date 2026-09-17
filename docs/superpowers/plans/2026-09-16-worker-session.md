# Agent Hive — sessão do worker dentro do app: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The detail panel becomes the worker's session: the output already polled from `GET /slots/:id/output` is rendered with fenced code blocks highlighted (comment / string / number / keyword) and `diff` fences coloured by line; every `Edit` the worker makes shows up as a ```` ```diff ```` block built from `old_string` / `new_string`; and when a turn ends with no PR open, the Hive marks the slot `esperando_voce` with the worker's final text as the pending question, so the card blinks and the input reads "responder ao worker". No new dependency, no DOM in the highlighter, no transcript file.

**Architecture:** `src/types.ts` gains the `idle` event (`{ type: 'idle'; workerId; question }`) and `StartWorker.onResult` becomes `(workerId, text) => void`. `src/orchestrator.ts` handles `idle`: unknown / `vazio` / `prUrl` → no change; otherwise `status: 'esperando_voce'`, `question` cut at 500 chars, `lastEvent: 'aguardando resposta'`, `paused` untouched. `src/workers.ts` reads `result` from the stream line and passes it to `onResult`, and `describeBlock` turns an `Edit` `tool_use` into `['▶ Edit: <path>', '```diff', -old…, +new…, '```']` with each side cut at 40 lines. `src/server.ts` replaces `endWhenReviewed` with `onTurnEnd(workerId, text)`: `aguardando_review` → `pool.end`, else `dispatch({ type: 'idle', … })`; it also serves `/ui/highlight.js`. `src/ui/highlight.ts` (new, pure) exports `esc`, `highlight(lang, body)` and `renderOutput(lines)`; `app.ts` imports both, renders `#output` (now a `<div>`) with `innerHTML = renderOutput(lines)` when the text changed, and switches the input placeholder by status.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`. `src/ui/*.ts` is compiled by the same `tsc` into `dist/src/ui/` and each module is served by an explicit route (`/ui/app.js`, `/ui/limits.js`, now `/ui/highlight.js`); `index.html` loads only `<script type="module" src="/ui/app.js">`, and `app.js` imports `./limits.js` / `./highlight.js` relative to it.

**Spec:** `docs/superpowers/specs/2026-09-16-worker-session-design.md` (extends `docs/superpowers/specs/2026-09-16-embedded-workers-design.md`). Its "Decisões fechadas" table is authoritative; nothing there is re-decided here.

## Global Constraints

- All v1, setup, boards, signal and embedded-workers constraints hold: immutable reducer, argv arrays (`spawn` / `execFile`) never shell strings, Portuguese UI copy, English code comments, conventional commits in English without trailers, no machine-specific values, tokens only via env (`hive.config.json` stays token-free).
- No new runtime dependencies: the highlighter is a regex tokenizer in `src/ui/highlight.ts` (no highlight.js, no CDN); the diff comes from the `Edit` tool input already in the stream.
- `run.ts`, `hive.ts`, `main.ts`, `spawn.ts`, `hooks-settings.ts`, `state-store.ts`, `src/boards/*`, `board.ts`, `config.ts`, `src/ui/limits.ts` do not change. `README.md` does not change (the spec lists no README wording).
- Interfaces are exactly the spec's "Config e tipos" section: `HiveEvent` gains `{ type: 'idle'; workerId: string; question: string }`; `StartWorker.onResult` becomes `(workerId: string, text: string) => void`; `Slot`, `Effect`, `Config`, `WorkerHandlers`, `WorkerHandle`, `SpawnWorker` are untouched.
- Tests never start a real `claude`: `test/workers.test.ts` and `test/server.test.ts` keep injecting the fake `SpawnWorker` from `test/fakes.ts`; `test/highlight.test.ts` imports `dist/src/ui/highlight.js` directly (no DOM in it). `test/setup.test.ts` keeps `maxConcurrent: 0`; `test/server.test.ts` keeps `maxConcurrent: 1` with the fake.
- Worker output never enters `State` (no persist / broadcast per line): the only text that lands in the state is the `result` text, cut at 500 chars into `Slot.question`, through the reducer.
- Escape: every character that came from the worker goes through `esc()` before any markup is added — `renderOutput` escapes text outside fences before the `<code>` replacement, `highlight` escapes each token and each gap as it emits them. The panel is `innerHTML`.
- New files < 400 lines (`src/ui/highlight.ts` < 120) and every function < 50 lines. `server.ts` grows only by `onTurnEnd` (replacing `endWhenReviewed`) and one `sendFile` route.
- Every task leaves `pnpm test` green (build + all suites) and ends in exactly one commit. Baseline before T1: 186 tests. Expected deltas: T1 +2, T2 +1, T3 +1, T4 +6, T5 0 (196 at the end).
- Every intermediate commit is coherent: `endWhenReviewed` goes in the same commit that adds `onTurnEnd` (T3); the local `esc` in `app.ts` goes in the same commit that imports it from `highlight.js` (T5); the `/ui/highlight.js` route lands with the import that needs it (T5).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `HiveEvent` gains `idle` (T1) |
| `src/orchestrator.ts` | `QUESTION_MAX`, `case 'idle'`, `idle(state, workerId, question)` (T1) |
| `src/workers.ts` | `DIFF_MAX`, `StreamLine.result`, `onResult(workerId, text)`, `diffSide` + `describeEdit`, `describeBlock` routes `Edit` (T2) |
| `src/server.ts` | T3: `onTurnEnd` replaces `endWhenReviewed`; T5: `GET /ui/highlight.js` |
| `src/ui/highlight.ts` | new — `esc`, `highlight`, `renderOutput` (T4) |
| `src/ui/index.html` | `#output` becomes a `<div>`; CSS for `.code`, `code`, `.add`, `.del`, `.hunk`, `.comment`, `.string`, `.number`, `.keyword`; token colours in `:root` (T5) |
| `src/ui/app.ts` | imports `esc` / `renderOutput` from `./highlight.js`, drops its local `esc`; `lastOutput`; `loadOutput` renders HTML; `syncOutputPolling` resets; input placeholder by status (T5) |
| `test/orchestrator.test.ts` | `idled` helper; 2 new `idle` tests (T1) |
| `test/workers.test.ts` | `started` records `[id, text]`; result test asserts the text; new `Edit` diff test (T2) |
| `test/server.test.ts` | existing result test asserts `esperando_voce` before the PR; new "result without PR" test (T3) |
| `test/highlight.test.ts` | new — 6 tests over `esc`, `highlight`, `renderOutput` (T4) |

---

### Task 1: Types and reducer — the `idle` event

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `HiveEvent` member `{ type: 'idle'; workerId: string; question: string }`.
- Produces (in `src/orchestrator.ts`): `QUESTION_MAX = 500` (module constant, not exported); `idle(state, workerId, question): Reduced` — unknown worker, `vazio` slot or slot with `prUrl` → `none(state)` (same object); otherwise `patch(state, workerId, { status: 'esperando_voce', question: question.slice(0, QUESTION_MAX), lastEvent: 'aguardando resposta' })`. No effects, no `fill` (nothing was freed). `paused` is not touched; `UserPromptSubmit` / `PreToolUse` already clear `question` and `paused`.
- Consumed by: T3 (`dispatch({ type: 'idle', … })`).

- [ ] **Step 1: Write the failing tests — `test/orchestrator.test.ts`**

After the `limited` helper add:

```ts
const idled = (state: State, workerId: string, question: string) => reduce(state, { type: 'idle', workerId, question });
```

After the test `hook for an empty or unknown slot is ignored` add:

```ts
test('idle without a PR turns the slot yellow with the question cut at 500 chars; the answer brings it back; paused is not touched', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = idled(first, id, 'Posso apagar o arquivo?');
  assert.equal(state.slots[0].status, 'esperando_voce');
  assert.equal(state.slots[0].question, 'Posso apagar o arquivo?');
  assert.equal(state.slots[0].lastEvent, 'aguardando resposta');
  assert.equal(effects.length, 0, 'no fill, no effects: nothing was freed');
  assert.equal(idled(first, id, 'x'.repeat(600)).state.slots[0].question?.length, 500);
  const answered = hook(state, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(answered.slots[0].status, 'trabalhando');
  assert.equal(answered.slots[0].question, undefined);
  const paused = stopped(signaled(first, 'red').state, id);
  const idlePaused = idled(paused, id, 'q').state;
  assert.equal(idlePaused.slots[0].status, 'esperando_voce');
  assert.equal(idlePaused.slots[0].paused, true, 'idle does not release the red mark');
});

test('idle with a PR, for an unknown worker or an empty slot leaves the state as is', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const withPr = idled(reviewed, id, 'algo');
  assert.equal(withPr.state, reviewed, 'same object: the server already closes stdin for a reviewed slot');
  assert.equal(withPr.effects.length, 0);
  assert.equal(idled(first, 'nope', 'algo').state, first);
  const empty = initialState(1);
  assert.equal(idled(empty, 'w', 'q').state, empty);
});
```

(Adapt helper names — `filled`, `hook`, `stopped`, `signaled`, `initialState` — to what the file actually defines; the behaviour asserted is what matters.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error in `test/orchestrator.test.ts` — `Type '"idle"' is not assignable to type …`.

- [ ] **Step 3: Edit `src/types.ts`**

After `  | { type: 'exit'; workerId: string }` insert:

```ts
  | { type: 'idle'; workerId: string; question: string } // a `result` line without a PR: the worker waits for input
```

- [ ] **Step 4: Edit `src/orchestrator.ts`**

Add `const QUESTION_MAX = 500;` next to the other module constants. In `reduce`, after the `exit` case add:

```ts
    case 'idle': return idle(state, event.workerId, event.question); // no fill: nothing was freed
```

After `exit` add:

```ts
// In print mode the worker asks in plain text and ends the turn: a `result` without a PR means nothing happens
// until someone types. Reuses the status and the card blink that Notification already has; the answer
// (UserPromptSubmit) clears the question. With a PR the server closes stdin instead, so there is nothing to show.
function idle(state: State, workerId: string, question: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'vazio' || slot.prUrl) return none(state);
  return patch(state, workerId, { status: 'esperando_voce', question: question.slice(0, QUESTION_MAX), lastEvent: 'aguardando resposta' });
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`, all PASS, 188 total.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: idle event marks a worker that ended its turn without a PR as waiting for you"
```

---

### Task 2: `src/workers.ts` — `onResult(workerId, text)` and the `Edit` diff block (TDD)

**Files:**
- Modify: `src/workers.ts`
- Test: `test/workers.test.ts`

**Interfaces:**
- `export const DIFF_MAX = 40` — lines shown per side of an `Edit`; `CUT_MARK = '…'` (not exported) closes a cut side.
- `StartWorker.onResult(workerId: string, text: string): void` — `text` is `String(parsed.result ?? '')`.
- `StreamLine.result?: string`.
- `describeBlock`: `tool_use` with `name === 'Edit'` → `['▶ Edit: <file_path ≤ 120>', '```diff', ...old lines prefixed '-', ...new lines prefixed '+', '```']`; a side longer than `DIFF_MAX` shows its first `DIFF_MAX` lines then `…`; an empty side contributes nothing. Every other tool is as today.
- Compatibility: `server.ts`'s `onResult: endWhenReviewed` (one parameter) still type-checks against the two-parameter signature, so the server does not change in this task.

- [ ] **Step 1: Update the tests — `test/workers.test.ts`**

Import `DIFF_MAX`. In `started`, `results` becomes `[string, string][]` and `onResult: (id, text) => results.push([id, text])`.

Replace the result test with:

```ts
test('a result line calls onResult with the worker id and the final text; other lines do not', () => {
  const { worker, results } = started();
  worker.handlers.onLine(assistant({ type: 'text', text: 'oi' }));
  worker.handlers.onLine(JSON.stringify({ type: 'system' }));
  worker.handlers.onLine('not json');
  assert.deepEqual(results, []);
  worker.handlers.onLine(JSON.stringify({ type: 'result', result: 'Posso apagar o arquivo?' }));
  assert.deepEqual(results, [['W1', 'Posso apagar o arquivo?']]);
  worker.handlers.onLine(JSON.stringify({ type: 'result' }));
  assert.deepEqual(results.at(-1), ['W1', ''], 'no result text: empty string, never undefined');
});
```

Add:

```ts
test('formatOutput renders an Edit as a diff block with the file path, cutting each side at DIFF_MAX lines', () => {
  const edit = (input: Record<string, unknown>): string[] => formatOutput(assistant({ type: 'tool_use', name: 'Edit', input }));
  assert.deepEqual(edit({ file_path: '/repo/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;' }), [
    '▶ Edit: /repo/a.ts', '```diff', '-const a = 1;', '-const b = 2;', '+const a = 10;', '```',
  ]);
  const many = Array.from({ length: DIFF_MAX + 5 }, (_, i) => `line ${i}`).join('\n');
  const long = edit({ file_path: '/repo/b.ts', old_string: many, new_string: 'x' });
  assert.equal(long.length, 2 + DIFF_MAX + 1 + 1 + 1, 'header, fence, DIFF_MAX old lines, cut mark, one new line, fence');
  assert.equal(long[2 + DIFF_MAX - 1], `-line ${DIFF_MAX - 1}`);
  assert.equal(long[2 + DIFF_MAX], '…');
  assert.equal(long[2 + DIFF_MAX + 1], '+x');
  assert.equal(long.at(-1), '```');
  assert.deepEqual(edit({ file_path: '/repo/c.ts', old_string: '', new_string: 'novo' }), ['▶ Edit: /repo/c.ts', '```diff', '+novo', '```'], 'an empty side adds no lines');
  assert.deepEqual(
    formatOutput(assistant({ type: 'tool_use', name: 'Write', input: { file_path: '/repo/d.ts', content: 'x'.repeat(5000) } })),
    ['▶ Write: /repo/d.ts'], 'Write stays a one-liner',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail** — build error: no exported member `DIFF_MAX`.

- [ ] **Step 3: Edit `src/workers.ts`**

```ts
export const DIFF_MAX = 40; // lines shown per side of an Edit; the panel is a glance, not a review
const CUT_MARK = '…';
```

`onResult(workerId: string, text: string): void;` in `StartWorker`; `result?: string` in `StreamLine`.

```ts
// One side of the Edit: every line prefixed, the side cut at DIFF_MAX with a mark; an empty side (a pure insertion) adds nothing.
function diffSide(sign: '-' | '+', text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const shown = lines.slice(0, DIFF_MAX).map((line) => `${sign}${line}`);
  return lines.length > DIFF_MAX ? [...shown, CUT_MARK] : shown;
}

// The only place in the stream where a diff exists: tool results are dropped and a Write can be huge.
function describeEdit(input: Record<string, unknown>): string[] {
  return [
    `▶ Edit: ${String(input.file_path ?? '').slice(0, TOOL_MAX)}`,
    '```diff',
    ...diffSide('-', String(input.old_string ?? '')),
    ...diffSide('+', String(input.new_string ?? '')),
    '```',
  ];
}
```

`describeBlock` routes `block.name === 'Edit'` to `describeEdit(input)` before the generic line. In `start`'s `onLine`:

```ts
        const parsed = parseLine(line);
        if (parsed?.type === 'result') o.onResult(workerId, String(parsed.result ?? ''));
```

- [ ] **Step 4: Run tests to verify they pass** — 189 total.

- [ ] **Step 5: Commit**

```bash
git add src/workers.ts test/workers.test.ts
git commit -m "feat: worker pool passes the result text and renders Edit as a diff block"
```

---

### Task 3: `src/server.ts` — `onTurnEnd` dispatches `idle` when there is no PR (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- `async function onTurnEnd(workerId: string, text: string): Promise<void>` — slot in `aguardando_review` → `pool.end(workerId)`; anything else → `await dispatch({ type: 'idle', workerId, question: text })` (the reducer ignores unknown / `vazio` / `prUrl`). Wired as `onResult: (workerId, text) => void onTurnEnd(workerId, text)`. Removes `endWhenReviewed`.

- [ ] **Step 1: Update the tests — `test/server.test.ts`**

In the existing result test, after the first `result` line (no PR yet) add `await waitFor(() => slot0(server).status === 'esperando_voce');` and pass `result: 'Abro o PR?'` in the line.

Add:

```ts
test('a result without a PR marks the slot as waiting for you with the final text as the question; the answer clears it', async (t) => {
  const { base, server, workers } = await start(t);
  const [worker] = workers;
  const { id, workerId } = slot0(server);
  line(worker, { type: 'result', result: 'Quer que eu abra o PR agora?' });
  await waitFor(() => slot0(server).status === 'esperando_voce');
  assert.equal(slot0(server).question, 'Quer que eu abra o PR agora?');
  assert.equal(slot0(server).lastEvent, 'aguardando resposta');
  assert.equal(worker.ended, 0, 'stdin stays open for the answer');
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/input`, { text: 'abre' })), { ok: true });
  await server.dispatch({ type: 'hook', workerId: workerId!, payload: { hook_event_name: 'UserPromptSubmit' } }); // what the worker's hook posts
  assert.equal(slot0(server).status, 'trabalhando');
  assert.equal(slot0(server).question, undefined);
});
```

(Adapt helper names to the file's actual `start` / `slot0` / `line` / `waitFor` / `json` / `postJson` helpers; if `server.dispatch` is not exposed, post the hook through `POST /hooks/event` with the worker id the way the other tests do.)

- [ ] **Step 2: Run tests to verify they fail** — `waitFor` times out in both tests.

- [ ] **Step 3: Edit `src/server.ts`**

```ts
  // A turn ended. With the PR open the task is done: closing stdin lets the worker exit and free the slot.
  // Without a PR nothing happens until someone types (print mode asks in text and stops), so the final text
  // becomes the pending question. Stop arrives before this (hooks block the turn end), so idle wins.
  async function onTurnEnd(workerId: string, text: string): Promise<void> {
    if (live?.state.slots.find((s) => s.workerId === workerId)?.status === 'aguardando_review') {
      pool.end(workerId);
      return;
    }
    await dispatch({ type: 'idle', workerId, question: text });
  }
```

`onResult: (workerId, text) => void onTurnEnd(workerId, text),`

- [ ] **Step 4: Run tests to verify they pass** — 190 total.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: server dispatches idle when a turn ends without a PR"
```

---

### Task 4: `src/ui/highlight.ts` — pure string → HTML (TDD)

**Files:**
- Create: `src/ui/highlight.ts`, `test/highlight.test.ts`

**Interfaces:**
- `esc(text: string): string` — the five HTML characters; byte-for-byte the `esc` in `app.ts` today (T5 makes `app.ts` import this one).
- `highlight(lang: string, body: string): string` — already-escaped HTML for one fence body. `diff` → `<span class="add|del|hunk">` by prefix `+` / `-` / `@@`. Anything else → one alternated regex, groups in the order `comment`, `string`, `number`, `keyword`; the earliest match owns its span. Each token and each gap is escaped as it is emitted.
- `renderOutput(lines: string[]): string` — `lines.join('\n').split('\n')`; a line matching `` ^```(\w*)\s*$ `` opens or closes a fence; outside, `esc(line)` with `` `x` `` → `<code>x</code>`; a fence → `<pre class="code" data-lang="<lang>">highlight(lang, body)</pre>`; an open fence at the end is rendered as is. Segments joined with `\n`.

- [ ] **Step 1: Write the failing tests — `test/highlight.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, highlight, renderOutput } from '../src/ui/highlight.js';

test('esc escapes the five HTML-significant characters and nothing else', () => {
  assert.equal(esc(`<a href="x">'&'</a> \`ok\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt; `ok`');
});

test('text outside a fence is escaped and `inline code` becomes <code>', () => {
  assert.equal(
    renderOutput(['<script>alert(1)</script>', 'use `pnpm test` & go', '▶ Bash: echo `a`']),
    '&lt;script&gt;alert(1)&lt;/script&gt;\nuse <code>pnpm test</code> &amp; go\n▶ Bash: echo <code>a</code>',
  );
});

test('a diff fence colours added, removed and hunk lines and escapes their content', () => {
  const html = renderOutput(['▶ Edit: a.ts', '```diff', '@@ -1 +1 @@', '-const a = "<x>";', '+const a = 1;', ' same', '```', 'depois']);
  assert.equal(html, [
    '▶ Edit: a.ts',
    '<pre class="code" data-lang="diff"><span class="hunk">@@ -1 +1 @@</span>\n'
      + '<span class="del">-const a = &quot;&lt;x&gt;&quot;;</span>\n'
      + '<span class="add">+const a = 1;</span>\n'
      + ' same</pre>',
    'depois',
  ].join('\n'));
});

test('a ts fence marks comments, strings, numbers and keywords without overlap, escaping as it goes', () => {
  assert.equal(
    highlight('ts', 'const n = 42; // "not a string"\nconst s = "a // b"; # <tag>'),
    '<span class="keyword">const</span> n = <span class="number">42</span>; <span class="comment">// &quot;not a string&quot;</span>\n'
      + '<span class="keyword">const</span> s = <span class="string">&quot;a // b&quot;</span>; <span class="comment"># &lt;tag&gt;</span>',
  );
  assert.equal(highlight('py', 'x1 = None'), 'x1 = <span class="keyword">None</span>', 'a digit inside an identifier is not a number');
  assert.equal(highlight('', '/* a\nb */ 3.14'), '<span class="comment">/* a\nb */</span> <span class="number">3.14</span>');
});

test('an unclosed fence runs to the end of the output', () => {
  assert.equal(renderOutput(['antes', '```sh', 'pnpm test', 'echo "x"']), 'antes\n<pre class="code" data-lang="sh">pnpm test\n<span class="keyword">echo</span> <span class="string">&quot;x&quot;</span></pre>');
});

test('a fence inside one output line with embedded newlines renders like separate lines; a fence without a language has an empty data-lang', () => {
  assert.equal(renderOutput(['antes\n```\nx < y\n```\ndepois']), 'antes\n<pre class="code" data-lang="">x &lt; y</pre>\ndepois');
  assert.equal(renderOutput([]), '');
});
```

- [ ] **Step 2: Run tests to verify they fail** — `Cannot find module '../src/ui/highlight.js'`.

- [ ] **Step 3: Create `src/ui/highlight.ts`**

```ts
// Pure string → HTML for the worker's output: no DOM, so node:test covers it. Every character that came from the
// worker goes through esc() before any markup is added around it; the panel renders the result with innerHTML.

const FENCE = /^```(\w*)\s*$/;
const INLINE_CODE = /`([^`\n]+)`/g;
const COMMENT = String.raw`\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/`;
const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`[^`]*`';
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;
// Short list shared by TS/JS, Python, Go, Rust and shell: enough to give a block some shape, no grammar per language.
const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'class', 'new',
  'async', 'await', 'def', 'fn', 'pub', 'struct', 'impl', 'match', 'type', 'interface', 'true', 'false', 'null', 'None',
  'self', 'this', 'then', 'fi', 'do', 'done', 'echo',
];
// One alternation, one pass, left to right: the earliest match owns its span, so a `//` inside a string stays a string.
const TOKEN = new RegExp(
  [COMMENT, STRING, NUMBER, String.raw`\b(?:${KEYWORDS.join('|')})\b`].map((group) => `(${group})`).join('|'), 'g',
);
const TOKEN_CLASS = ['comment', 'string', 'number', 'keyword']; // same order as the groups above
const DIFF_CLASS: [string, string][] = [['+', 'add'], ['-', 'del'], ['@@', 'hunk']];

interface Fence {
  lang: string;
  body: string[];
}

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function diffLines(body: string): string {
  return body.split('\n').map((line) => {
    const cls = DIFF_CLASS.find(([prefix]) => line.startsWith(prefix))?.[1];
    return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
  }).join('\n');
}

function tokenize(body: string): string {
  let out = '';
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const cls = TOKEN_CLASS[m.slice(1).findIndex((group) => group !== undefined)];
    out += `${esc(body.slice(last, m.index))}<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(body.slice(last));
}

/** The body of one fence as HTML: `diff` by line prefix, anything else by the token regex. The result is already escaped. */
export function highlight(lang: string, body: string): string {
  return lang === 'diff' ? diffLines(body) : tokenize(body);
}

function block({ lang, body }: Fence): string {
  return `<pre class="code" data-lang="${esc(lang)}">${highlight(lang, body.join('\n'))}</pre>`;
}

function inline(line: string): string {
  return esc(line).replace(INLINE_CODE, '<code>$1</code>');
}

/** The panel's HTML: fenced blocks become <pre class="code">, everything else is escaped text with `inline` as <code>. */
export function renderOutput(lines: string[]): string {
  const out: string[] = [];
  let fence: Fence | undefined;
  for (const line of lines.join('\n').split('\n')) {
    const mark = FENCE.exec(line);
    if (fence && mark) {
      out.push(block(fence));
      fence = undefined;
    } else if (fence) {
      fence.body.push(line);
    } else if (mark) {
      fence = { lang: mark[1], body: [] };
    } else {
      out.push(inline(line));
    }
  }
  if (fence) out.push(block(fence)); // still open at the end: the worker is mid-block, show what is there
  return out.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass** — 196 total; `dist/src/ui/highlight.js` exists.

- [ ] **Step 5: Commit**

```bash
git add src/ui/highlight.ts test/highlight.test.ts
git commit -m "feat: pure highlight module for the worker output"
```

---

### Task 5: UI wiring — `#output` as HTML, placeholder by status, `/ui/highlight.js` route

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`, `src/server.ts`

- [ ] **Step 1: `src/server.ts`** — next to the `/ui/limits.js` route:

```ts
  app.get('/ui/highlight.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'highlight.js')));
```

- [ ] **Step 2: `src/ui/index.html` — CSS**

Add to `:root`: `--code-bg: #0b0e12; --string: #d7a86e; --number: #c792ea; --keyword: #7fb4f5;`

Replace the `#output` rule with:

```css
  #output { font: 12px/1.4 ui-monospace, monospace; min-height: 60px; max-height: 300px; overflow: auto; white-space: pre-wrap; background: var(--bg); padding: 8px; border-radius: 6px; }
  #output .code { margin: 0; padding: 6px 8px; max-height: none; background: var(--code-bg); border: 1px solid var(--border); }
  #output code { background: var(--panel); padding: 0 4px; border-radius: 4px; }
  #output .add { color: var(--trabalhando); }
  #output .del { color: var(--danger); }
  #output .hunk { color: var(--review); }
  #output .comment { color: var(--muted); font-style: italic; }
  #output .string { color: var(--string); }
  #output .number { color: var(--number); }
  #output .keyword { color: var(--keyword); }
```

- [ ] **Step 3: `src/ui/index.html` — markup**: `<pre id="output"></pre>` → `<div id="output"></div>`.

- [ ] **Step 4: `src/ui/app.ts`**

`import { esc, renderOutput } from './highlight.js';` — delete the local `esc`. Constants `INPUT_PLACEHOLDER = 'mensagem pro worker'`, `ANSWER_PLACEHOLDER = 'responder ao worker'`. Module state `let lastOutput = '';`.

```ts
async function loadOutput(): Promise<void> {
  const slotId = outputSlotId;
  if (!slotId) return;
  try {
    const { lines } = await getJson<{ lines: string[] }>(`/slots/${slotId}/output`);
    if (slotId !== outputSlotId) return; // the panel moved on while the request was in flight
    const text = lines.join('\n');
    if (text === lastOutput) return;
    lastOutput = text;
    const el = $('output');
    el.innerHTML = renderOutput(lines); // every worker character is escaped inside renderOutput
    el.scrollTop = el.scrollHeight; // follows the worker as the output grows
  } catch (err) {
    showError((err as Error).message);
  }
}
```

In `syncOutputPolling`: `$('output').innerHTML = ''; lastOutput = '';`. In `renderDetail`, before `panel.classList.add('show')`:

```ts
  $<HTMLInputElement>('input').placeholder = slot.status === 'esperando_voce' ? ANSWER_PLACEHOLDER : INPUT_PLACEHOLDER;
```

- [ ] **Step 5: `pnpm test`** — all PASS, 196; `grep -c "function esc" dist/src/ui/app.js` → 0.

- [ ] **Step 6: Manual check (PR test plan)** — `pnpm start <scratch repo>` with `maxConcurrent: 1`, one task in the queue, `claudeArgs: ["--permission-mode", "acceptEdits"]`: a code block in the output shows in a darker box with coloured tokens; an `Edit` shows as a red/green diff; `<script>` in the text appears literally; a turn ending with a question and no PR makes the card blink `esperando você`, the panel shows the question under "pendente:" and the placeholder reads `responder ao worker`; answering brings it back to `trabalhando`.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/ui/index.html src/ui/app.ts
git commit -m "feat: detail panel renders the output with highlight and diffs; input asks to answer the worker"
```
