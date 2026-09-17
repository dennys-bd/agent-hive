# Agent Hive — worker embutido interativo (terminal sob demanda, painel só de detalhe): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The embedded worker stops being a print-mode child over stdio and becomes a real interactive `claude` session running hidden in a detached `tmux` session of the Hive (`tmux -L hive`, one session per worker named after the slug), opened in the user's terminal by a `terminal` button on the card and by "ir pro terminal" in the panel. Permissions and questions are answered in that terminal, so the worker never stalls on a denied tool. The panel becomes detail only: title, PR, pending question, worktree, branch, issue link and an excerpt of the transcript (`transcript_path` from `SessionStart`, tail of the `.jsonl` formatted by `formatOutput`). The input line, `POST /slots/:id/input`, `send` / `end` on the handle and the pool, the stdout ring, the `result` line and the `idle` event all go. A `Stop` with the PR open kills the session so the slot frees itself in both modes. macOS and Linux.

**Architecture:** `src/transcript.ts` (new) takes `formatOutput` from `workers.ts` (no `result` case, non-JSON → `[]`) and adds `tailTranscript(path, max)` (`stat` + `open`/`read` at an offset, last `TAIL_BYTES`, first partial line dropped). `src/terminal.ts` (new) exports `openTerminal(argv, deps)`: darwin → iTerm2 tab via `openItermTab` (now exported from `spawn-iterm.ts`), fallback Terminal.app via `osascript`; linux → `$TERMINAL` / `x-terminal-emulator -e …`; else reject. `src/spawn-tmux.ts` (new) exports `spawnTmuxWorker(launch, handlers, deps)` and `attachArgv(slug)`: `tmux -L hive new-session -d -s <slug> -c <repo> -x 200 -y 50 <workerCommand>` with `workerEnv`, `kill` = `kill-session` then `onExit`, `focus` = `openTerminal(attachArgv)`. `src/types.ts`: `WorkerHandlers = { onExit, onError }`, `WorkerHandle = { kill, focus }`, `WorkerLaunch` without `prompt`, `Slot.transcriptPath`, `HiveEvent` without `idle`, `Exec` (injectable promisified `execFile`). `src/workers.ts` is only the registry (`start`, `kill`, `exit`, `focus`, `killAll`, `has`). `src/spawn.ts` keeps `renderPrompt`, `writePrompt`, `workerEnv`, `killStray`, `spawnWorker` (tmux for `embedded`, iTerm for `iterm`). `src/orchestrator.ts` stores `transcriptPath` on `SessionStart` and loses `idle`. `src/server.ts` wires `onError` → `fail`, kills on `Stop` + `aguardando_review`, serves the transcript tail on `GET /slots/:id/output`, drops `/input`. The UI gets `terminal` on the card, loses the input row and the per-mode CSS.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `node:child_process.execFile` + `node:fs/promises` (stdlib only). `tmux` is a system tool like `gh` and `claude`, not a package.

**Spec:** `docs/superpowers/specs/2026-09-17-interactive-workers-design.md` (extends `docs/superpowers/specs/2026-09-16-embedded-workers-design.md` and `2026-09-16-worker-session-design.md`). Its "Decisões fechadas" table is authoritative; nothing there is re-decided here.

## Global Constraints

- All v1, setup, boards, signal, embedded-workers and worker-session constraints hold: immutable reducer, `execFile` with argv arrays (the one shell string in the repo stays `workerCommand` in `spawn-iterm.ts`, and `tmux` receives it as a single argv element), Portuguese UI copy, English code comments, conventional commits in English without trailers, no machine-specific values, tokens only via env (`hive.config.json` stays token-free).
- No new runtime dependencies: `tmux` is required at runtime for the `embedded` mode only (README + form hint say so); without it the spawn fails, the error bar shows it and the slot frees, exactly as today without `claude` on PATH.
- New files: `src/transcript.ts`, `src/terminal.ts`, `src/spawn-tmux.ts`, `test/transcript.test.ts`, `test/terminal.test.ts`, `test/spawn-tmux.test.ts`. Removed symbols: `spawnEmbeddedWorker`, `workerArgv`, `WorkerArgvOptions`, `userMessage` (spawn), `WorkerLaunch.prompt`, `WorkerHandlers.onLine`, `WorkerHandle.send` / `end` (`focus` becomes required), `WorkerPool.send` / `end` / `output`, `StartWorker.onResult`, `RESULT_LINE`, `OUTPUT_LINES` (moves), `HiveEvent` `idle`, `QUESTION_MAX`, `onTurnEnd`, `INPUT_MESSAGE`, `NO_TAB_MESSAGE`, `POST /slots/:id/input`, `WRITE_SCRIPT`. `run.ts`, `hive.ts`, `main.ts`, `hooks-settings.ts`, `state-store.ts`, `config.ts`, `board.ts`, `src/boards/*`, `polling.ts`, `rate-limits.ts`, `usage.ts`, `usage-rules.ts`, `src/ui/highlight.ts`, `src/ui/limits.ts` do not change.
- Interfaces are exactly the spec's "Tipos" section (T5) plus `Exec` (T2) and `Slot.transcriptPath` (T4).
- Tests never shell out to `tmux`, `osascript`, `claude` or a terminal: every spawner and `openTerminal` take an injectable `exec` (`(file, args, opts?) => Promise<{ stdout }>`), the fakes record argv and can be made to reject. `test/server.test.ts` and `test/workers.test.ts` keep injecting `fakeSpawn()` from `test/fakes.ts`. `killStray` keeps its one real `pkill` test (exit 1, no match).
- Worker output never enters `State` and is never kept by the pool: `GET /slots/:id/output` reads the transcript tail on every call (`TAIL_BYTES = 256 KiB`, at most `OUTPUT_LINES = 200` formatted lines), only from an absolute `.jsonl` path that `SessionStart` reported (`isTranscriptPath`).
- Every error a spawner produces goes through `handlers.onError(message)` → `StartWorker.onError` → `fail('worker <slug>', …)` → `State.error`; nothing is thrown from a handle. `focus` may reject (the route answers 500 with the message).
- Files < 400 lines and every function < 50 lines. `server.ts` (548 today) shrinks: the input route and `onTurnEnd` pay for `slotOf` and the `Stop` kill.
- Every task leaves `pnpm test` green (build + all suites) and ends in exactly one commit. Baseline before T1: 224 tests (`grep -c "^test(" test/*.test.ts test/boards/*.test.ts`). Expected deltas: T1 +3 (227), T2 +5 (232), T3 +4 (236), T4 −1 (235), T5 −7 (228), T6 0 (228 at the end).
- Every intermediate commit is coherent: `formatOutput` leaves `workers.ts` in the commit that adds `transcript.ts` (T1, the pool imports it there); `openItermTab` is exported and used by `spawnItermWorker` in the same commit (T2); the pool's ring, `output` and `RESULT_LINE` go in the commit that makes the panel read the transcript (T4); `onLine`, `send`, `end`, `prompt`, `idle`, the print-mode spawner, `/input` and every test of theirs go in one commit (T5), together with the four-line flip that puts `spawn-tmux.ts` on the final handler shape; the UI and README change only after the server they describe (T6).

---

## File map

| File | Change |
|---|---|
| `src/transcript.ts` | new — `OUTPUT_LINES`, `TAIL_BYTES`, `DIFF_MAX`, `DIFF_LINE_MAX`, `parseLine`, `formatOutput` (moved), `tailTranscript` (T1) |
| `src/workers.ts` | T1: imports `formatOutput` / `parseLine` / `OUTPUT_LINES`, keeps the ring through `ringLines`; T4: no ring, no `output`, no `RESULT_LINE`; T5: no `send` / `end` / `onResult` / `ended`, `onError` forwarded, `focus` always present |
| `src/types.ts` | T2: `Exec`; T4: `Slot.transcriptPath`; T5: `WorkerHandlers` `{ onExit, onError }`, `WorkerHandle` `{ kill, focus }`, `WorkerLaunch` without `prompt`, no `idle`, comments |
| `src/spawn-iterm.ts` | T2: `openItermTab(text, exec)` exported and used; T5: `onError`, handle `{ kill, focus }`, no `WRITE_SCRIPT` |
| `src/terminal.ts` | new — `openTerminal(argv, deps)` (T2) |
| `src/spawn-tmux.ts` | new — `TMUX_SOCKET`, `attachArgv`, `spawnTmuxWorker` (T3); T5: `onError`, no `send` / `end` |
| `src/spawn.ts` | T5: no `spawnEmbeddedWorker`, `workerArgv`, `userMessage`, `spawn` / `readline` imports; `spawnWorker` picks tmux |
| `src/orchestrator.ts` | T4: `SessionStart` stores `transcriptPath`; T5: no `idle`, no `QUESTION_MAX` |
| `src/server.ts` | T4: `GET /slots/:id/output` reads the transcript tail; T5: `onError` → `fail`, `Stop` + review → `pool.kill`, no `/input`, no `onTurnEnd`, `/focus` messages |
| `src/ui/index.html` | T6: no input row, no per-mode CSS, select and hint copy |
| `src/ui/app.ts` | T6: `terminal` on the card, no `sendInput` / placeholders / `applyWorkersMode`, polling in both modes |
| `README.md` | T6: modes, diagram, step 2, requirements, usage, config table, limitations |
| `test/fakes.ts` | T5: `FakeWorker` without `sent` / `ended`, always `focus`, `focusError`; `LAUNCH` without `prompt` |
| `test/transcript.test.ts` | new — 4 `formatOutput` tests (moved) + 3 `tailTranscript` tests (T1) |
| `test/terminal.test.ts` | new — 4 tests (T2) |
| `test/spawn-tmux.test.ts` | new — 4 tests (T3); T5 flips the error assertions |
| `test/workers.test.ts` | T1: −4 (moved); T4: −1 (ring); T5: −1 net (`result`, `send after end` out; `onError` in; `send/end/kill` → `kill`) |
| `test/spawn.test.ts` | T2: +1 `openItermTab`; T5: −3 (`workerArgv`, `userMessage`, `spawnEmbeddedWorker`) |
| `test/orchestrator.test.ts` | T4: `SessionStart` asserts `transcriptPath`; T5: −2 `idle` tests |
| `test/server.test.ts` | T4: `/output` test rewritten over a temp transcript; T5: −3 (`input`, two `result`), +2 (`Stop` kill, `onError`), focus test rewritten |

---

### Task 1: `src/transcript.ts` — `formatOutput` moves, `tailTranscript` reads the tail (TDD)

**Files:**
- Create: `src/transcript.ts`, `test/transcript.test.ts`
- Modify: `src/workers.ts`, `test/workers.test.ts`

**Interfaces:**
- Produces (in `src/transcript.ts`): `OUTPUT_LINES = 200`, `TAIL_BYTES = 256 * 1024`, `DIFF_MAX = 40`, `DIFF_LINE_MAX = 200` (exported); `interface TranscriptLine { type?; message?; result? }` (exported; `result` leaves in T5); `parseLine(line): TranscriptLine | undefined` (exported until T5, the pool still detects `result` with it); `formatOutput(line): string[]` — invalid JSON, non-object or `type !== 'assistant'` → `[]`; `assistant` → same blocks as today (text ≤ 2000, `▶ tool: detail` ≤ 120, `Edit` as one diff entry); `tailTranscript(path, max = OUTPUT_LINES): Promise<string[]>` — `stat` (rejects when not a regular file), `open` + `read` of the last `TAIL_BYTES` at the offset, split on `\n`, the first line dropped when the read did not start at byte 0, `flatMap(formatOutput)`, `slice(-max)`.
- `src/workers.ts` keeps `RESULT_LINE` and its ring for now through `ringLines(line, parsed)`: non-JSON → `[line]`, `result` → `[RESULT_LINE]`, else `formatOutput(line)`. Behaviour of the pool is unchanged in this task; only the code moved.
- Consumed by: T4 (`tailTranscript` in the server), T5.

- [ ] **Step 1: Write the failing tests — `test/transcript.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIFF_LINE_MAX, DIFF_MAX, formatOutput, OUTPUT_LINES, TAIL_BYTES, tailTranscript } from '../src/transcript.js';

const assistant = (...content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
const text = (t: string): string => assistant({ type: 'text', text: t });

async function transcript(lines: string[]): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-transcript-')), 'session.jsonl');
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

test('formatOutput shows assistant text blocks and tool calls with their main argument', () => {
  const line = assistant(
    { type: 'text', text: 'vou olhar o arquivo' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'roda os testes' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
    { type: 'tool_use', name: 'Task', input: { description: 'explora o repo' } },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
  );
  assert.deepEqual(formatOutput(line), [
    'vou olhar o arquivo', '▶ Read: /repo/src/a.ts', '▶ Bash: pnpm test', '▶ Grep: TODO', '▶ Task: explora o repo', '▶ TodoWrite',
  ]);
});

test('formatOutput truncates text to 2000 chars and tool arguments to 120', () => {
  const [t, tool] = formatOutput(
    assistant({ type: 'text', text: 'x'.repeat(2500) }, { type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(300) } }),
  );
  assert.equal(t.length, 2000);
  assert.equal(tool, `▶ Bash: ${'y'.repeat(120)}`);
});

test('formatOutput hides result / system / user / stream_event lines and anything that is not a JSON object', () => {
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'result', subtype: 'success' })), [], 'a transcript has no result lines');
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'stream_event' })), []);
  assert.deepEqual(formatOutput('stderr: warning: something'), []);
  assert.deepEqual(formatOutput('42'), []);
  assert.deepEqual(formatOutput(''), []);
});

test('formatOutput renders an Edit as one diff block entry with the file path, cutting each side at DIFF_MAX lines', () => {
  const edit = (input: Record<string, unknown>): string[] => formatOutput(assistant({ type: 'tool_use', name: 'Edit', input }));
  assert.deepEqual(edit({ file_path: '/repo/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;' }), [
    '▶ Edit: /repo/a.ts', '```diff\n-const a = 1;\n-const b = 2;\n+const a = 10;\n```',
  ], 'the whole block is one entry, so a cut at `max` lines never leaves a stray closing fence');
  const many = Array.from({ length: DIFF_MAX + 5 }, (_, i) => `line ${i}`).join('\n');
  const long = edit({ file_path: '/repo/b.ts', old_string: many, new_string: 'x' })[1].split('\n');
  assert.equal(long.length, 1 + DIFF_MAX + 1 + 1 + 1, 'fence, DIFF_MAX old lines, cut mark, one new line, fence');
  assert.equal(long[DIFF_MAX], `-line ${DIFF_MAX - 1}`);
  assert.equal(long[DIFF_MAX + 1], '…');
  assert.equal(long[DIFF_MAX + 2], '+x');
  assert.equal(long.at(-1), '```');
  assert.deepEqual(edit({ file_path: '/repo/c.ts', old_string: '', new_string: 'novo' }), ['▶ Edit: /repo/c.ts', '```diff\n+novo\n```'], 'an empty side adds no lines');
  assert.equal(edit({ file_path: 'w.ts', old_string: 'a\r\nb\rc', new_string: '' })[1], '```diff\n-a\n-b\n-c\n```', 'CRLF and CR normalised: no \\r reaches the panel');
  const blob = edit({ file_path: 'm.js', old_string: '', new_string: 'x'.repeat(DIFF_LINE_MAX + 50) })[1].split('\n')[1];
  assert.equal(blob, `+${'x'.repeat(DIFF_LINE_MAX)}`, 'a line is cut at DIFF_LINE_MAX');
  assert.deepEqual(
    formatOutput(assistant({ type: 'tool_use', name: 'Write', input: { file_path: '/repo/d.ts', content: 'x'.repeat(5000) } })),
    ['▶ Write: /repo/d.ts'], 'Write stays a one-liner',
  );
});

test('tailTranscript returns the last `max` formatted lines of the file, skipping what formatOutput hides', async () => {
  const path = await transcript([
    JSON.stringify({ type: 'user', message: { content: 'faz a task' } }),
    ...Array.from({ length: 5 }, (_, i) => text(`passo ${i}`)),
    'not json',
    assistant({ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }),
  ]);
  assert.deepEqual(await tailTranscript(path), ['passo 0', 'passo 1', 'passo 2', 'passo 3', 'passo 4', '▶ Bash: pnpm test']);
  assert.deepEqual(await tailTranscript(path, 2), ['passo 4', '▶ Bash: pnpm test']);
  assert.equal(OUTPUT_LINES, 200);
});

test('tailTranscript reads only the last TAIL_BYTES and drops the first line of a read that did not start at byte 0, whole or not', async () => {
  // The tail is built so the cut falls exactly on a line start: `first` is whole in the read and is still dropped, which
  // proves the rule is positional (a truly partial line would fail to parse anyway).
  const first = text('primeira');
  const last = text('última');
  const padLine = (n: number): string => JSON.stringify({ type: 'system', pad: 'p'.repeat(n) });
  const overhead = Buffer.byteLength(`${first}\n${last}\n${padLine(0)}\n`);
  const tail = [first, padLine(TAIL_BYTES - overhead), last]; // exactly TAIL_BYTES on disk
  const beyond = await transcript([text('antes'), ...tail]);
  assert.deepEqual(await tailTranscript(beyond), ['última']);
  const within = await transcript(tail);
  assert.deepEqual(await tailTranscript(within), ['primeira', 'última'], 'a read from byte 0 keeps its first line');
});

test('tailTranscript rejects a missing path and a path that is not a regular file', async () => {
  await assert.rejects(tailTranscript('/definitely/missing/session.jsonl'), { code: 'ENOENT' });
  await assert.rejects(tailTranscript(tmpdir()), /não é um arquivo regular/);
});
```

- [ ] **Step 2: Update `test/workers.test.ts`**

Line 3 → two lines:

```ts
import { createWorkerPool, RESULT_LINE } from '../src/workers.js';
import { OUTPUT_LINES } from '../src/transcript.js';
```

Delete the four `formatOutput` tests (`shows assistant text blocks…`, `truncates text…`, `marks a result…`, `renders an Edit…`). The `assistant` helper stays (the `result` test uses it).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Cannot find module '../src/transcript.js'`.

- [ ] **Step 4: Create `src/transcript.ts`**

```ts
import { open, stat } from 'node:fs/promises';

export const OUTPUT_LINES = 200;
export const TAIL_BYTES = 256 * 1024; // more than OUTPUT_LINES of any session; a transcript can be tens of MB and is read on every poll
export const DIFF_MAX = 40; // lines shown per side of an Edit; the panel is a glance, not a review
export const DIFF_LINE_MAX = 200; // chars per diff line: a minified blob must not become one unbounded panel entry
const CUT_MARK = '…';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface TranscriptLine {
  type?: string;
  message?: { content?: ContentBlock[] };
  result?: string; // print-mode stream only; a transcript never has it
}

// One JSON object per line, the same shape in the transcript and in the print-mode stream. Anything else is not a line.
export function parseLine(line: string): TranscriptLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TranscriptLine) : undefined;
  } catch {
    return undefined;
  }
}

// One side of the Edit: every line prefixed and cut at DIFF_LINE_MAX, the side cut at DIFF_MAX with a mark; an empty
// side (a pure insertion) adds nothing. CRLF is normalised so no `\r` reaches the panel.
function diffSide(sign: '-' | '+', text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const shown = lines.slice(0, DIFF_MAX).map((line) => `${sign}${line.slice(0, DIFF_LINE_MAX)}`);
  return lines.length > DIFF_MAX ? [...shown, CUT_MARK] : shown;
}

// The only place in the transcript where a diff exists: tool results are dropped and a Write can be huge. The whole block
// is one entry (like an assistant text block), so a cut at `max` lines never splits a fence and leaves a stray closing marker.
function describeEdit(input: Record<string, unknown>): string[] {
  const block = [
    '```diff',
    ...diffSide('-', String(input.old_string ?? '')),
    ...diffSide('+', String(input.new_string ?? '')),
    '```',
  ];
  return [`▶ Edit: ${String(input.file_path ?? '').slice(0, TOOL_MAX)}`, block.join('\n')];
}

function describeBlock(block: ContentBlock): string[] {
  if (block.type === 'text') return block.text ? [block.text.slice(0, TEXT_MAX)] : [];
  if (block.type !== 'tool_use') return [];
  const input = block.input ?? {};
  if (block.name === 'Edit') return describeEdit(input);
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? '').slice(0, TOOL_MAX);
  const name = block.name ?? 'tool';
  return [detail ? `▶ ${name}: ${detail}` : `▶ ${name}`];
}

/** What one transcript line becomes in the panel: assistant text and tool calls; nothing for the rest. */
export function formatOutput(line: string): string[] {
  const parsed = parseLine(line);
  if (parsed?.type !== 'assistant') return [];
  return (parsed.message?.content ?? []).flatMap(describeBlock);
}

/** The last `max` formatted lines of a transcript, read from its tail only: no state, nothing kept between calls. */
export async function tailTranscript(path: string, max = OUTPUT_LINES): Promise<string[]> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`não é um arquivo regular: ${path}`);
  const start = Math.max(0, info.size - TAIL_BYTES);
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return (start > 0 ? lines.slice(1) : lines).flatMap(formatOutput).slice(-max); // a read from mid-file starts inside a line
  } finally {
    await file.close();
  }
}
```

- [ ] **Step 5: Edit `src/workers.ts`**

Replace lines 1–9 (imports and constants) with:

```ts
import { formatOutput, OUTPUT_LINES, parseLine, type TranscriptLine } from './transcript.js';
import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export const RESULT_LINE = '✔ turno encerrado';
```

Delete `ContentBlock`, `StreamLine`, `parseLine`, `diffSide`, `describeEdit`, `describeBlock` and `formatOutput` (lines 37–98). In their place:

```ts
// The stdout ring: stderr (not JSON) passes through and a `result` gets its mark; the rest is what the transcript shows.
function ringLines(line: string, parsed: TranscriptLine | undefined): string[] {
  if (!parsed) return [line];
  return parsed.type === 'result' ? [RESULT_LINE] : formatOutput(line);
}
```

In `start`'s `onLine`:

```ts
      onLine: (line) => {
        const entry = entries.get(workerId);
        if (!entry) return; // a line after the exit: nobody is watching this worker any more
        const parsed = parseLine(line);
        entry.lines = [...entry.lines, ...ringLines(line, parsed)].slice(-OUTPUT_LINES);
        if (parsed?.type === 'result') o.onResult(workerId, String(parsed.result ?? ''));
      },
```

- [ ] **Step 6: Run tests to verify they pass** — `pnpm test`, all PASS, 227 total (`workers` −4, `transcript` +7). `test/server.test.ts` is untouched: `RESULT_LINE` and the `stderr:` pass-through still come out of the ring.

- [ ] **Step 7: Commit**

```bash
git add src/transcript.ts src/workers.ts test/transcript.test.ts test/workers.test.ts
git commit -m "refactor: transcript module with formatOutput and tailTranscript"
```

---

### Task 2: `src/terminal.ts` — `openTerminal(argv, deps)`; `openItermTab` exported (TDD)

**Files:**
- Create: `src/terminal.ts`, `test/terminal.test.ts`
- Modify: `src/types.ts`, `src/spawn-iterm.ts`, `test/spawn.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `export type Exec = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>` — the promisified `execFile`, injectable so tests never run a command (`promisify(execFile)` is assignable to it).
- Produces (in `src/spawn-iterm.ts`): `export async function openItermTab(text: string, exec: Exec = execFileAsync): Promise<string>` — `exec('osascript', ['-e', OPEN_TAB_SCRIPT, text])`, resolves to the trimmed stdout (the session's unique id). `spawnItermWorker` calls it instead of `osascript(OPEN_TAB_SCRIPT, …)`.
- Produces (in `src/terminal.ts`): `interface TerminalDeps { exec: Exec; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }`; `openTerminal(argv: string[], deps: Partial<TerminalDeps> = {}): Promise<void>` — `darwin`: `command = argv.map(shellQuote).join(' ')`, `openItermTab(command, exec)`; on rejection `exec('osascript', ['-e', TERMINAL_APP_SCRIPT, command])` (an `on run argv` script: `tell application "Terminal"` → `do script (item 1 of argv)` + `activate`); a Terminal.app failure propagates. `linux`: `exec(env.TERMINAL ?? 'x-terminal-emulator', ['-e', ...argv])`. Anything else: rejects with `terminal não suportado em <platform>`.
- Consumed by: T3 (`spawnTmuxWorker.focus`).

- [ ] **Step 1: Write the failing tests — `test/terminal.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminal } from '../src/terminal.js';
import type { Exec } from '../src/types.js';

interface Call { file: string; args: string[] }
const ARGV = ['tmux', '-L', 'hive', 'attach', '-d', '-t', "it's"];
const QUOTED = "'tmux' '-L' 'hive' 'attach' '-d' '-t' 'it'\\''s'";
const isIterm = (args: string[]): boolean => args[1].includes('com.googlecode.iterm2');

// Records every command; `rejectWhen` makes the matching calls fail like a missing app would.
function fakeExec(rejectWhen?: (args: string[]) => boolean): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (rejectWhen?.(args)) throw new Error('osascript: iTerm2 not found');
    return { stdout: 'session-1\n' };
  };
  return { exec, calls };
}

test('darwin types the shell-quoted argv into an iTerm2 tab and stops there when it works', async () => {
  const { exec, calls } = fakeExec();
  await openTerminal(ARGV, { exec, platform: 'darwin', env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.ok(isIterm(calls[0].args));
  assert.equal(calls[0].args[2], QUOTED);
});

test('darwin falls back to Terminal.app with the same string when iTerm2 refuses; a Terminal.app failure propagates', async () => {
  const { exec, calls } = fakeExec(isIterm);
  await openTerminal(ARGV, { exec, platform: 'darwin', env: {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, 'osascript');
  assert.equal(calls[1].args[0], '-e');
  assert.ok(calls[1].args[1].includes('on run argv'));
  assert.ok(calls[1].args[1].includes('tell application "Terminal"'));
  assert.ok(calls[1].args[1].includes('do script (item 1 of argv)'));
  assert.ok(calls[1].args[1].includes('activate'));
  assert.equal(calls[1].args[2], QUOTED);
  const all = fakeExec(() => true);
  await assert.rejects(openTerminal(ARGV, { exec: all.exec, platform: 'darwin', env: {} }), /iTerm2 not found/);
  assert.equal(all.calls.length, 2, 'both apps were tried');
});

test('linux runs $TERMINAL, or x-terminal-emulator, with -e and the argv as is', async () => {
  const { exec, calls } = fakeExec();
  await openTerminal(ARGV, { exec, platform: 'linux', env: { TERMINAL: 'kitty' } });
  await openTerminal(ARGV, { exec, platform: 'linux', env: {} });
  assert.deepEqual(calls, [{ file: 'kitty', args: ['-e', ...ARGV] }, { file: 'x-terminal-emulator', args: ['-e', ...ARGV] }]);
});

test('any other platform rejects without running anything', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(openTerminal(ARGV, { exec, platform: 'win32', env: {} }), { message: 'terminal não suportado em win32' });
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Update `test/spawn.test.ts`**

Line 7 → `import { openItermTab, shellQuote, workerCommand } from '../src/spawn-iterm.js';` and add `import type { Exec } from '../src/types.js';` after it. Append:

```ts
test('openItermTab runs the open-tab script with the text as argv 1 and resolves to the session id', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: 'w0t1p0:ABCD\n' };
  };
  assert.equal(await openItermTab("echo 'oi'", exec), 'w0t1p0:ABCD');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.equal(calls[0][1], '-e');
  assert.ok(calls[0][2].includes('com.googlecode.iterm2'));
  assert.ok(calls[0][2].includes('write text (item 1 of argv)'));
  assert.equal(calls[0][3], "echo 'oi'");
});
```

- [ ] **Step 3: Run tests to verify they fail** — build errors: `Cannot find module '../src/terminal.js'`, `'Exec'` / `'openItermTab'` not exported.

- [ ] **Step 4: Edit `src/types.ts`** — after the `Board` interface add:

```ts
/** `execFile` promisified. Every spawner and the terminal opener take one, so tests never run a command. */
export type Exec = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
```

- [ ] **Step 5: Edit `src/spawn-iterm.ts`**

Line 4 → `import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';`; line 6 → `const execFileAsync: Exec = promisify(execFile);`.

After `OPEN_TAB_SCRIPT` add:

```ts
/** Opens an iTerm2 tab typing `text` (a shell string) and resolves to the session's unique id. `terminal.ts` reuses it for the attach. */
export async function openItermTab(text: string, exec: Exec = execFileAsync): Promise<string> {
  const { stdout } = await exec('osascript', ['-e', OPEN_TAB_SCRIPT, text]);
  return stdout.trim();
}
```

In `spawnItermWorker`: `const session = osascript(OPEN_TAB_SCRIPT, workerCommand(launch)).catch(…)` → `const session = openItermTab(workerCommand(launch)).catch(…)`. `osascript` stays for `inTab`.

- [ ] **Step 6: Create `src/terminal.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openItermTab, shellQuote } from './spawn-iterm.js';
import type { Exec } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const DEFAULT_LINUX_TERMINAL = 'x-terminal-emulator'; // the Debian alternative; xterm, urxvt, konsole and xfce4-terminal all take `-e cmd args…`
// Every Mac has Terminal.app: `do script` opens a window running the line, `activate` brings it to the front.
const TERMINAL_APP_SCRIPT = `
on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`;

export interface TerminalDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

async function openDarwin(command: string, exec: Exec): Promise<void> {
  try {
    await openItermTab(command, exec);
  } catch {
    await exec('osascript', ['-e', TERMINAL_APP_SCRIPT, command]); // iTerm2 missing or refused: a Terminal.app failure propagates
  }
}

/** Opens `argv` in a terminal the user can type into: an iTerm2 tab or a Terminal.app window on macOS, `$TERMINAL` on Linux. */
export async function openTerminal(argv: string[], deps: Partial<TerminalDeps> = {}): Promise<void> {
  const { exec = execFileAsync, platform = process.platform, env = process.env } = deps;
  if (platform === 'darwin') {
    // AppleScript types one line into a shell: the argv becomes a shell string here and only here
    await openDarwin(argv.map(shellQuote).join(' '), exec);
    return;
  }
  if (platform === 'linux') {
    await exec(env.TERMINAL ?? DEFAULT_LINUX_TERMINAL, ['-e', ...argv]);
    return;
  }
  throw new Error(`terminal não suportado em ${platform}`);
}
```

- [ ] **Step 7: Run tests to verify they pass** — `pnpm test`, all PASS, 232 total (`terminal` +4, `spawn` +1).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/spawn-iterm.ts src/terminal.ts test/terminal.test.ts test/spawn.test.ts
git commit -m "feat: openTerminal opens an argv in iTerm2, Terminal.app or \$TERMINAL"
```

---

### Task 3: `src/spawn-tmux.ts` — the worker in a detached tmux session (TDD)

**Files:**
- Create: `src/spawn-tmux.ts`, `test/spawn-tmux.test.ts`

**Interfaces:**
- Produces (in `src/spawn-tmux.ts`): `TMUX_SOCKET = 'hive'` (exported); `SESSION_COLS = '200'`, `SESSION_ROWS = '50'`; `tmuxArgs(...args) = ['-L', TMUX_SOCKET, ...args]`; `attachArgv(slug) = ['tmux', ...tmuxArgs('attach', '-d', '-t', slug)]` (exported); `interface TmuxDeps { exec: Exec; openTerminal(argv: string[]): Promise<void> }`; `spawnTmuxWorker(launch, handlers, deps: Partial<TmuxDeps> = {}): WorkerHandle` — `exec('tmux', tmuxArgs('new-session', '-d', '-s', slug, '-c', repo, '-x', '200', '-y', '50', workerCommand(launch)), { env: workerEnv(process.env, workerId, port) })`; rejection → the error reported + `onExit()` once. Handle: `kill` waits for the `new-session` call, runs `exec('tmux', tmuxArgs('kill-session', '-t', slug))`, reports a rejection (never throws) and then `onExit()` once; `focus` waits for the `new-session` call and calls `deps.openTerminal(attachArgv(slug))`.
- Transitional shape (this task only, flipped by T5 in four lines): `WorkerHandlers` still has `onLine` and no `onError`, so errors are reported as `handlers.onLine('stderr: tmux: <message>')` like `spawnItermWorker` does today; `WorkerHandle` still requires `send` / `end`, so the handle carries the two no-ops the iTerm handle has. Nothing calls `spawnTmuxWorker` until T5 wires it into `spawnWorker`.
- Consumed by: T5.

- [ ] **Step 1: Write the failing tests — `test/spawn-tmux.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerCommand } from '../src/spawn-iterm.js';
import { attachArgv, spawnTmuxWorker, TMUX_SOCKET } from '../src/spawn-tmux.js';
import type { Exec } from '../src/types.js';
import { LAUNCH } from './fakes.js';

interface Call { file: string; args: string[]; env?: NodeJS.ProcessEnv }

// Records every command; `failing` makes the calls whose args include that word reject.
function fakeExec(failing?: string): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    if (failing && args.includes(failing)) throw new Error(`${failing} boom`);
    return { stdout: '' };
  };
  return { exec, calls };
}

function handlers() {
  const lines: string[] = [];
  let exits = 0;
  return { lines, exits: () => exits, handlers: { onLine: (l: string) => lines.push(l), onExit: () => { exits += 1; } } };
}
const noTerminal = async (): Promise<void> => {};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('spawnTmuxWorker starts a detached session named after the slug, in the repo, 200x50, running workerCommand with the hive env', () => {
  const { exec, calls } = fakeExec();
  spawnTmuxWorker(LAUNCH, handlers().handlers, { exec, openTerminal: noTerminal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'tmux');
  assert.deepEqual(calls[0].args, [
    '-L', TMUX_SOCKET, 'new-session', '-d', '-s', 'hive-1-task', '-c', '/repo', '-x', '200', '-y', '50', workerCommand(LAUNCH),
  ]);
  assert.equal(calls[0].env?.HIVE_WORKER_ID, 'W1');
  assert.equal(calls[0].env?.HIVE_PORT, '4242');
  assert.equal(calls[0].env?.CLAUDECODE, undefined, 'the tmux server is born without it, or the child would refuse to start');
  assert.equal(TMUX_SOCKET, 'hive');
});

test('a new-session that fails reports the error and the exit, once', async () => {
  const { exec } = fakeExec('new-session');
  const h = handlers();
  spawnTmuxWorker(LAUNCH, h.handlers, { exec, openTerminal: noTerminal });
  await tick();
  assert.deepEqual(h.lines, ['stderr: tmux: new-session boom']);
  assert.equal(h.exits(), 1);
});

test('kill runs kill-session and reports the exit once, even when kill-session fails', async () => {
  const ok = fakeExec();
  const h = handlers();
  const handle = spawnTmuxWorker(LAUNCH, h.handlers, { exec: ok.exec, openTerminal: noTerminal });
  handle.kill();
  await tick();
  assert.deepEqual(ok.calls[1], { file: 'tmux', args: ['-L', TMUX_SOCKET, 'kill-session', '-t', 'hive-1-task'], env: undefined });
  assert.equal(h.exits(), 1);
  assert.deepEqual(h.lines, []);
  handle.kill();
  await tick();
  assert.equal(h.exits(), 1, 'a second kill does not exit twice');
  const failing = fakeExec('kill-session');
  const h2 = handlers();
  spawnTmuxWorker(LAUNCH, h2.handlers, { exec: failing.exec, openTerminal: noTerminal }).kill();
  await tick();
  assert.deepEqual(h2.lines, ['stderr: tmux: kill-session boom']);
  assert.equal(h2.exits(), 1, 'the session is given as gone either way');
});

test('focus opens a terminal on the attach argv; attachArgv detaches other clients so the newest terminal wins', async () => {
  const opened: string[][] = [];
  const handle = spawnTmuxWorker(LAUNCH, handlers().handlers, { exec: fakeExec().exec, openTerminal: async (argv) => { opened.push(argv); } });
  await handle.focus!();
  assert.deepEqual(opened, [['tmux', '-L', 'hive', 'attach', '-d', '-t', 'hive-1-task']]);
  assert.deepEqual(attachArgv('s'), ['tmux', '-L', TMUX_SOCKET, 'attach', '-d', '-t', 's']);
});
```

- [ ] **Step 2: Run tests to verify they fail** — build error: `Cannot find module '../src/spawn-tmux.js'`.

- [ ] **Step 3: Create `src/spawn-tmux.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workerCommand } from './spawn-iterm.js';
import { workerEnv } from './spawn.js';
import { openTerminal } from './terminal.js';
import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
export const TMUX_SOCKET = 'hive'; // a server of the Hive's own: isolated from the user's tmux, born with the worker env
const SESSION_COLS = '200'; // detached, a session would be 80x24 and the scrollback would wrap at 80 when a terminal attaches
const SESSION_ROWS = '50';

export interface TmuxDeps {
  exec: Exec;
  openTerminal(argv: string[]): Promise<void>;
}

const tmuxArgs = (...args: string[]): string[] => ['-L', TMUX_SOCKET, ...args];

/** What the terminal runs to show a worker: `-d` detaches any other client, so the newest terminal wins the size. */
export function attachArgv(slug: string): string[] {
  return ['tmux', ...tmuxArgs('attach', '-d', '-t', slug)];
}

/**
 * A worker in a detached tmux session named after the slug: `claude` gets a real TTY (permission prompts, questions) and
 * the terminal opens only on focus. The command is the same shell string iTerm types; tmux runs it through the shell,
 * so it travels as one argv element. Its `; curl /hooks/exit` trailer reports the natural exit.
 */
export function spawnTmuxWorker(launch: WorkerLaunch, handlers: WorkerHandlers, deps: Partial<TmuxDeps> = {}): WorkerHandle {
  const { exec = execFileAsync, openTerminal: open = openTerminal } = deps;
  const { slug } = launch;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  const report = (err: Error): void => handlers.onLine(`stderr: tmux: ${err.message}`);
  const session = exec('tmux', tmuxArgs(
    'new-session', '-d', '-s', slug, '-c', launch.repo, '-x', SESSION_COLS, '-y', SESSION_ROWS, workerCommand(launch),
  ), { env: workerEnv(process.env, launch.workerId, launch.port) }).catch((err: Error) => {
    report(err); // tmux missing or the name taken: the worker never started, free the slot
    exitOnce();
  });
  return {
    send: () => {}, // interactive claude: the human types in the terminal
    end: () => {}, // nothing to close; the session ends with the command
    // kill-session SIGHUPs the shell, so the curl trailer never runs: the handle reports the exit itself, after the kill
    kill: () => void session.then(() => exec('tmux', tmuxArgs('kill-session', '-t', slug))).catch(report).then(() => exitOnce()),
    focus: () => session.then(() => open(attachArgv(slug))),
  };
}
```

`workerEnv` comment in `src/spawn.ts` line 40 → `/** The env the worker (and the tmux server, born with its first client) gets: the Hive's own minus CLAUDECODE (a Hive launched from inside Claude Code would stop the child from starting), plus the worker id and port. */`

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`, all PASS, 236 total (`spawn-tmux` +4).

- [ ] **Step 5: Commit**

```bash
git add src/spawn-tmux.ts src/spawn.ts test/spawn-tmux.test.ts
git commit -m "feat: tmux spawner runs the worker in a detached session of the Hive"
```

---

### Task 4: The panel excerpt comes from the transcript — `Slot.transcriptPath`, `GET /slots/:id/output` reads the tail, the ring goes (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`, `src/server.ts`, `src/workers.ts`
- Test: `test/orchestrator.test.ts`, `test/server.test.ts`, `test/workers.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Slot.transcriptPath?: string` — `// from SessionStart; where GET /slots/:id/output reads the excerpt`.
- Produces (in `src/orchestrator.ts`): `SessionStart` → `patch(state, workerId, { worktree: p.cwd, branch, transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined })`.
- Produces (in `src/server.ts`): `GET /slots/:id/output` → 404 when the slot does not exist or is `vazio`; otherwise `{ lines: slot.transcriptPath ? await tailTranscript(slot.transcriptPath).catch(() => []) : [] }`.
- Removes (in `src/workers.ts`): `RESULT_LINE`, `ringLines`, `Entry.lines`, `WorkerPool.output`, the `formatOutput` / `OUTPUT_LINES` imports (`parseLine` stays for `result`).
- Consumed by: T6 (the panel polls in both modes).

- [ ] **Step 1: Update `test/orchestrator.test.ts`** — replace the `SessionStart records worktree and branch` test with:

```ts
test('SessionStart records worktree, branch and the transcript path; a path that is not an absolute .jsonl is ignored', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1', transcript_path: '/Users/x/.claude/projects/p/abc.jsonl' },
  });
  assert.equal(state.slots[0].worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(state.slots[0].branch, 'hive-1-task-1');
  assert.equal(state.slots[0].transcriptPath, '/Users/x/.claude/projects/p/abc.jsonl');
  const relative = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', transcript_path: 'abc.jsonl' }).state;
  assert.equal(relative.slots[0].transcriptPath, undefined);
  assert.equal(hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w' }).state.slots[0].transcriptPath, undefined);
});
```

- [ ] **Step 2: Update `test/server.test.ts`**

Line 3 → `import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';`. Delete line 11 (`import { RESULT_LINE } …`). Replace the `GET /slots/:id/output` test with:

```ts
test('GET /slots/:id/output is the formatted tail of the transcript SessionStart pointed at; [] before the hook or when unreadable; unknown slot is 404', async (t) => {
  const { base, repo, server } = await start(t);
  const { id, workerId } = slot0(server);
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] });
  const transcriptPath = join(repo, 'session.jsonl');
  await writeFile(transcriptPath, [
    JSON.stringify({ type: 'user', message: { content: 'faz a task' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'lendo o issue' }, { type: 'tool_use', name: 'Bash', input: { command: 'gh issue view 1' } }] } }),
    '',
  ].join('\n'));
  await server.dispatch({ type: 'hook', workerId: workerId!, payload: { hook_event_name: 'SessionStart', cwd: repo, transcript_path: transcriptPath } });
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: ['lendo o issue', '▶ Bash: gh issue view 1'] });
  await rm(transcriptPath);
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] }, 'an unreadable transcript is an empty excerpt, not an error');
  assert.equal((await fetch(`${base}/slots/nope/output`)).status, 404);
});
```

- [ ] **Step 3: Update `test/workers.test.ts`**

Line 3–4 → `import { createWorkerPool } from '../src/workers.js';` (drop `RESULT_LINE` and the `transcript.js` import). Delete the test `output keeps the last 200 formatted lines and returns a copy`. In `exit removes the worker and calls onExit…` delete the line `assert.deepEqual(pool.output('W1'), []);`.

- [ ] **Step 4: Run tests to verify they fail** — build error: `Property 'transcriptPath' does not exist on type 'Slot'`.

- [ ] **Step 5: Edit `src/types.ts`** — in `Slot`, after `question?: string;` add:

```ts
  transcriptPath?: string; // from SessionStart; where GET /slots/:id/output reads the excerpt
```

- [ ] **Step 6: Edit `src/orchestrator.ts`**

Line 3 → `import { hasBudget, isTranscriptPath, pruneUsage } from './usage.js';`. The `SessionStart` case:

```ts
    case 'SessionStart': // the transcript path is kept only when it is what Claude Code sends: an absolute .jsonl
      return patch(state, workerId, { worktree: p.cwd, branch, transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined });
```

- [ ] **Step 7: Edit `src/workers.ts`**

Line 1 → `import { parseLine } from './transcript.js';`. Delete `export const RESULT_LINE …`, `ringLines`, `Entry.lines`, `output` in `WorkerPool` and in the returned object. `onLine`:

```ts
      onLine: (line) => {
        if (!entries.has(workerId)) return; // a line after the exit: nobody is watching this worker any more
        const parsed = parseLine(line);
        if (parsed?.type === 'result') o.onResult(workerId, String(parsed.result ?? ''));
      },
```

`entries.set(workerId, { handle, ended: false, exit: onExit })`. The doc comment of `createWorkerPool` stays.

- [ ] **Step 8: Edit `src/server.ts`**

Line 17 → add `import { tailTranscript } from './transcript.js';` next to it. Replace the `/slots/:id/output` route with:

```ts
  // The excerpt is the tail of the transcript SessionStart reported, read on every call: nothing is kept in memory.
  // Unreadable (rotated, not written yet) is an empty excerpt, not an error.
  app.get('/slots/:id/output', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot || slot.status === 'vazio') {
      res.status(HTTP_NOT_FOUND).json({ error: SLOT_EMPTY_MESSAGE });
      return;
    }
    res.json({ lines: slot.transcriptPath ? await tailTranscript(slot.transcriptPath).catch(() => []) : [] });
  });
```

- [ ] **Step 9: Run tests to verify they pass** — `pnpm test`, all PASS, 235 total (`workers` −1).

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/server.ts src/workers.ts test/orchestrator.test.ts test/server.test.ts test/workers.test.ts
git commit -m "feat: the panel excerpt comes from the transcript SessionStart points at"
```

---

### Task 5: The cut-over — interactive handlers, tmux for `embedded`, no input, `Stop` with a PR kills the session (TDD)

**Files:**
- Modify: `src/types.ts`, `src/workers.ts`, `src/spawn.ts`, `src/spawn-iterm.ts`, `src/spawn-tmux.ts`, `src/orchestrator.ts`, `src/server.ts`
- Test: `test/fakes.ts`, `test/workers.test.ts`, `test/spawn.test.ts`, `test/spawn-tmux.test.ts`, `test/orchestrator.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`, exactly the spec's "Tipos"):
  - `interface WorkerHandlers { onExit(): void; onError(message: string): void }`
  - `interface WorkerHandle { kill(): void; focus(): Promise<void> }`
  - `WorkerLaunch` without `prompt`; `HiveEvent` without `idle`; comments on `WorkersMode`, `HookPayload.transcript_path`, `WorkerLaunch.promptPath`.
- Produces (in `src/workers.ts`): `StartWorker = { workerId, launch, onExit(), onError(message) }`; `WorkerPool = { start, kill, exit, focus, killAll, has }`; `focus(workerId)` → `false` when unknown, else awaits `handle.focus()` and returns `true`.
- Produces (in `src/spawn.ts`): `spawnWorker` picks `spawnTmuxWorker` for `embedded`, `spawnItermWorker` for `iterm`. Removes `WorkerArgvOptions`, `workerArgv`, `userMessage`, `spawnEmbeddedWorker`, the `spawn` / `readline` imports.
- Produces (in `src/spawn-iterm.ts`): `report` → `handlers.onError(\`iTerm: ${err.message}\`)`; handle `{ kill, focus }`; `WRITE_SCRIPT` removed.
- Produces (in `src/spawn-tmux.ts`): `report` → `handlers.onError(\`tmux: ${err.message}\`)`; handle `{ kill, focus }`.
- Produces (in `src/orchestrator.ts`): `idle` case and function and `QUESTION_MAX` removed.
- Produces (in `src/server.ts`): `slotOf(workerId)`; `spawn` passes `launch` without `prompt` and `onError: (message) => void fail(\`worker ${slot.slug}\`, new Error(message))`; `POST /hooks/event` → after `res.sendStatus(200)`, `Stop` on a slot in `aguardando_review` → `pool.kill(workerId)`; `POST /slots/:id/focus` → 404 `NO_WORKER_MESSAGE` when the pool has no live worker, 500 with the message when the terminal fails. Removes `onTurnEnd`, `INPUT_MESSAGE`, `NO_TAB_MESSAGE`, `POST /slots/:id/input`.
- Produces (in `test/fakes.ts`): `FakeWorker { launch; handlers; killed; focused; focusError? }`; `fakeSpawn()` (no argument) always returns a handle with `focus`; `LAUNCH` without `prompt`.
- Consumed by: T6.

- [ ] **Step 1: Update `test/fakes.ts`** — replace lines 4–38 with:

```ts
export interface FakeWorker {
  launch: WorkerLaunch;
  handlers: WorkerHandlers;
  killed: number;
  focused: number;
  focusError?: Error; // set by a test: the next focus() rejects, like a terminal that cannot open
}

/** A SpawnWorker that opens nothing: records every call and exposes the handlers so a test can report errors and exits. */
export function fakeSpawn(): { spawn: SpawnWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = (launch, handlers) => {
    const worker: FakeWorker = { launch, handlers, killed: 0, focused: 0 };
    workers.push(worker);
    return {
      kill: () => {
        worker.killed += 1;
      },
      focus: async () => {
        worker.focused += 1;
        if (worker.focusError) throw worker.focusError;
      },
    };
  };
  return { spawn, workers };
}

export const LAUNCH: WorkerLaunch = {
  mode: 'embedded', workerId: 'W1', slug: 'hive-1-task', repo: '/repo', port: 4242,
  hooksPath: '/repo/.hive/hooks.json', promptPath: '/repo/.hive/prompts/hive-1-task.md', claudeArgs: [],
};
```

- [ ] **Step 2: Rewrite `test/workers.test.ts`** (final content)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool } from '../src/workers.js';
import { fakeSpawn, LAUNCH } from './fakes.js';

const noop = (): void => {};

function started(workerId = 'W1') {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const errors: string[] = [];
  pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: () => exits.push(workerId), onError: (message) => errors.push(message) });
  return { pool, worker: workers[0], workers, exits, errors };
}

test('start hands the launch to the spawner and registers the worker', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.launch, LAUNCH);
  assert.equal(pool.has('W1'), true);
  assert.equal(pool.has('W2'), false);
});

test('an error reported by the spawner reaches StartWorker.onError as is; the worker stays registered', () => {
  const { worker, pool, errors } = started();
  worker.handlers.onError('tmux: spawn tmux ENOENT');
  assert.deepEqual(errors, ['tmux: spawn tmux ENOENT']);
  assert.equal(pool.has('W1'), true, 'only onExit frees the entry');
});

test('exit removes the worker and calls onExit once; later calls report it unknown', () => {
  const { worker, pool, exits } = started();
  worker.handlers.onExit();
  worker.handlers.onExit();
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.kill('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('exit(workerId) is the external exit signal (the curl trailer): same effect as the handle exiting, false when unknown', () => {
  const { pool, exits } = started();
  assert.equal(pool.exit('W1'), true);
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.equal(pool.exit('W1'), false);
});

test('kill reaches the handle of a live worker and returns true; the entry stays until the exit', () => {
  const { worker, pool } = started();
  assert.equal(pool.kill('W1'), true);
  assert.equal(worker.killed, 1);
  assert.equal(pool.has('W1'), true);
});

test('focus awaits the handle and returns true; false for an unknown worker; a failing terminal rejects', async () => {
  const { worker, pool } = started();
  assert.equal(await pool.focus('W1'), true);
  assert.equal(worker.focused, 1);
  assert.equal(await pool.focus('nope'), false);
  worker.focusError = new Error('terminal não suportado em win32');
  await assert.rejects(pool.focus('W1'), /win32/);
});

test('killAll sends kill to every live worker and skips the ones that already exited', () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2', 'W3']) {
    pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: noop, onError: noop });
  }
  workers[0].handlers.onExit();
  pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});

test('a spawner that reports the exit before returning the handle leaves no entry behind', () => {
  const pool = createWorkerPool((_launch, handlers) => {
    handlers.onExit();
    return { kill: noop, focus: async () => {} };
  });
  const exits: string[] = [];
  pool.start({ workerId: 'W1', launch: LAUNCH, onExit: () => exits.push('W1'), onError: noop });
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
});
```

(8 tests: the `result` and `send after end` tests are gone, `send, end and kill` became `kill`, `onError` is new — net −1.)

- [ ] **Step 3: Update `test/spawn.test.ts`**

Lines 3–6 →

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killStray, renderPrompt, workerEnv, writePrompt } from '../src/spawn.js';
```

Delete the tests `workerArgv puts the worktree…`, `userMessage wraps text…`, `spawnEmbeddedWorker sends the prompt…` and the `echoBinary` helper. `renderPrompt` ×2, `writePrompt`, `workerEnv`, `killStray`, `shellQuote`, `workerCommand`, `openItermTab` stay (−3).

- [ ] **Step 4: Update `test/spawn-tmux.test.ts`** — the four-line flip:

```ts
function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
```

`h.lines` → `h.errors` in the three assertions, with the expected values `['tmux: new-session boom']`, `[]` and `['tmux: kill-session boom']`; `await handle.focus!()` → `await handle.focus()`.

- [ ] **Step 5: Update `test/orchestrator.test.ts`** — delete the `idled` helper (line 40) and the two tests `idle without a PR turns the slot yellow…` and `idle with a PR, for an unknown worker or an empty slot…` (−2).

- [ ] **Step 6: Update `test/server.test.ts`**

`start(t, body = BODY)` — drop the `withFocus` parameter and pass nothing to `fakeSpawn()`. Add a helper after `openPr`:

```ts
// What the worker's hook command posts: the JSON payload on the body, the worker id on the header.
const hookEvent = (base: string, workerId: string, payload: unknown): Promise<Response> =>
  fetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-worker': workerId }, body: JSON.stringify(payload) });
```

In `saving the setup starts one worker with the launch…`: the expected `launch` loses `prompt`; keep `readFile(promptPath)` as a separate assertion that the file holds the rendered prompt:

```ts
  assert.deepEqual(workers[0].launch, {
    mode: 'embedded', workerId: slot.workerId, slug: 'hive-1-from-ready', repo, port,
    hooksPath: join(repo, '.hive', 'hooks.json'), promptPath, claudeArgs: [],
  });
  assert.match(await readFile(promptPath, 'utf8'), /from Ready/, 'the command line reads the prompt from this file');
```

`workers: iterm in the setup…` → `await start(t, { ...BODY, workers: 'iterm' })`. Replace `POST /slots/:id/focus is 404 for an embedded worker…` with:

```ts
test('POST /slots/:id/focus reaches the handle of an embedded worker too; an unknown slot is 404 and a terminal that fails is 500', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/focus`)), { ok: true });
  assert.equal(workers[0].focused, 1);
  assert.equal((await postJson(`${base}/slots/nope/focus`)).status, 404);
  workers[0].focusError = new Error('terminal não suportado em win32');
  const failed = await postJson(`${base}/slots/${id}/focus`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'terminal não suportado em win32' });
});
```

Delete `POST /slots/:id/input writes to the worker…`, `a result closes stdin only once the PR is open…` and `a result without a PR marks the slot as waiting…`. Delete the `line` helper (line 27). Add:

```ts
test('a Stop kills the session only once the PR is open; the exit then frees the slot without requeueing', async (t) => {
  const { base, server, workers } = await start(t);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop' })).status, 200);
  assert.equal(worker.killed, 0, 'no PR yet: the session stays for the next turn');
  assert.equal(slot0(server).status, 'trabalhando');
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'aguardando_review');
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop' })).status, 200);
  await waitFor(() => worker.killed === 1);
  worker.handlers.onExit();
  await waitFor(() => slot0(server).status === 'vazio');
  assert.deepEqual(server.getState()?.queue, []);
  assert.equal(workers.length, 1, 'nothing left to spawn');
});

test('an error reported by the spawner lands in State.error with the worker slug', async (t) => {
  const { server, workers } = await start(t);
  workers[0].handlers.onError('tmux: spawn tmux ENOENT');
  await waitFor(() => server.getState()?.error === 'worker hive-1-from-ready: tmux: spawn tmux ENOENT');
  assert.equal(slot0(server).status, 'trabalhando', 'only the exit frees the slot');
});
```

(−3 +2 = −1.)

- [ ] **Step 7: Run tests to verify they fail** — build errors: `'onError' does not exist in type 'WorkerHandlers'`, `Property 'send' is missing…`, `'prompt' is missing in type…`.

- [ ] **Step 8: Edit `src/types.ts`**

The `WorkersMode` doc comment → `/** Where a worker runs: a detached tmux session of the Hive with the terminal opened on demand, or an iTerm2 tab the Hive opens and watches. */`
`HookPayload.transcript_path` → `  transcript_path?: string; // Claude Code sends it on every hook; the server reads tokens from it on Stop / SessionEnd, the reducer keeps it from SessionStart`
Delete the `HiveEvent` member `| { type: 'idle'; workerId: string; question: string } // …`.
Replace `WorkerHandlers`, `WorkerHandle` and `WorkerLaunch` (the three declarations after `Exec`) with:

```ts
/** What the server injects so tests never open a session. */
export interface WorkerHandlers {
  onExit(): void; // once, on session end, kill or spawn failure
  onError(message: string): void; // spawner failures (tmux / iTerm missing or refused): shown in the dashboard error bar
}

export interface WorkerHandle {
  kill(): void; // tmux kill-session, or pkill by slug for a tab
  focus(): Promise<void>; // opens (or brings to the front) the worker's terminal
}

/** Everything a spawner needs to start one worker; each mode turns it into a session or a tab its own way. */
export interface WorkerLaunch {
  mode: WorkersMode;
  workerId: string;
  slug: string;
  repo: string;
  port: number;
  hooksPath: string;
  promptPath: string; // the rendered prompt on disk: the command line reads it with $(cat …)
  claudeArgs: string[];
}
```

- [ ] **Step 9: Rewrite `src/workers.ts`** (final content)

```ts
import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onError(message: string): void; // a spawner failure: the server puts it in the error bar
}

export interface WorkerPool {
  start(o: StartWorker): void;
  kill(workerId: string): boolean; // false when the worker is unknown
  exit(workerId: string): boolean; // an exit reported from outside (the curl trailer): same as the handle exiting
  focus(workerId: string): Promise<boolean>; // false when unknown; rejects when the terminal cannot open
  killAll(): void;
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  exit(): void;
}

/** In-memory registry of live workers keyed by workerId. Process state, not domain state: it is never persisted. */
export function createWorkerPool(spawn: SpawnWorker): WorkerPool {
  const entries = new Map<string, Entry>();

  function start(o: StartWorker): void {
    const { workerId } = o;
    let exited = false;
    const onExit = (): void => {
      if (exited) return; // once: the handle and the external signal can both report it
      exited = true;
      entries.delete(workerId);
      o.onExit();
    };
    const handle = spawn(o.launch, { onExit, onError: o.onError });
    if (!exited) entries.set(workerId, { handle, exit: onExit }); // a spawner may fail before returning
  }

  function call(workerId: string, action: (entry: Entry) => void): boolean {
    const entry = entries.get(workerId);
    if (!entry) return false;
    action(entry);
    return true;
  }

  return {
    start,
    kill: (workerId) => call(workerId, (entry) => entry.handle.kill()),
    exit: (workerId) => call(workerId, (entry) => entry.exit()),
    focus: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.focus();
      return true;
    },
    killAll: () => {
      for (const { handle } of entries.values()) handle.kill();
    },
    has: (workerId) => entries.has(workerId),
  };
}
```

- [ ] **Step 10: Rewrite `src/spawn.ts`** (final content)

```ts
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawnItermWorker } from './spawn-iterm.js';
import { spawnTmuxWorker } from './spawn-tmux.js';
import type { SpawnWorker, Task } from './types.js';

const execFileAsync = promisify(execFile);
const NO_MATCH_EXIT = 1;

export function renderPrompt(template: string, task: Task): string {
  const values: Record<string, string> = {
    id: task.id, number: task.id, title: task.title, body: task.body, url: task.url, // {number} is a synonym of {id}
  };
  return template.replace(/\{(id|number|title|body|url)\}/g, (_, key: string) => values[key]);
}

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, text);
  return path;
}

/** The env the worker (and the tmux server, born with its first client) gets: the Hive's own minus CLAUDECODE (a Hive launched from inside Claude Code would stop the child from starting), plus the worker id and port. */
export function workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv {
  const { CLAUDECODE: _inherited, ...env } = base;
  return { ...env, HIVE_WORKER_ID: workerId, HIVE_PORT: String(port) };
}

/** The default spawner: picks the implementation by `config.workers`. Both run an interactive claude. */
export const spawnWorker: SpawnWorker = (launch, handlers) =>
  (launch.mode === 'iterm' ? spawnItermWorker(launch, handlers) : spawnTmuxWorker(launch, handlers));

/** Boot-only orphan defense (and the tab's kill): kills a worker that may still hold the worktree. Resolves true when pkill matched. */
export async function killStray(slug: string): Promise<boolean> {
  try {
    await execFileAsync('pkill', ['-f', '--', `--worktree=${slug}`]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}
```

- [ ] **Step 11: Edit `src/spawn-iterm.ts`**

Delete `const WRITE_SCRIPT = …`. Replace `spawnItermWorker` with:

```ts
/**
 * A worker in an iTerm2 tab. The exit comes from the `; curl /hooks/exit` at the end of the command, which the server
 * forwards to the pool; a kill goes through pkill by slug and the exit arrives the same way.
 */
export function spawnItermWorker(launch: WorkerLaunch, handlers: WorkerHandlers): WorkerHandle {
  const report = (err: Error): void => handlers.onError(`iTerm: ${err.message}`);
  const session = openItermTab(workerCommand(launch)).catch((err: Error) => {
    report(err); // iTerm missing or refused: the worker never started, free the slot
    handlers.onExit();
    return undefined;
  });
  return {
    kill: () => void killStray(launch.slug).catch(report),
    focus: () => session.then((id) => (id === undefined ? undefined : inTab(id, FOCUS_SCRIPT))),
  };
}
```

- [ ] **Step 12: Edit `src/spawn-tmux.ts`** — the flip: `const report = (err: Error): void => handlers.onError(\`tmux: ${err.message}\`);` and delete the `send` and `end` lines of the handle.

- [ ] **Step 13: Edit `src/orchestrator.ts`** — delete `const QUESTION_MAX = 500;`, the `case 'idle': return idle(…)` line in `reduce` and the `idle` function with its three-line comment (between `exit` and `boot`).

- [ ] **Step 14: Edit `src/server.ts`**

Delete the `NO_TAB_MESSAGE` and `INPUT_MESSAGE` constants. Inside `createServer`, after `eventsPayload` add:

```ts
  const slotOf = (workerId: string): Slot | undefined => live?.state.slots.find((s) => s.workerId === workerId);
```

and use it in `turnTokens` (`const slot = slotOf(workerId);`). Replace `spawn` and delete `onTurnEnd`:

```ts
  async function spawn(runtime: Runtime, slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const { workerId } = slot;
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task)); // the command line reads it
    pool.start({
      workerId,
      launch: { mode: config.workers, workerId, slug: slot.slug, repo, port: config.port, hooksPath, promptPath, claudeArgs: config.claudeArgs },
      onExit: () => void dispatch({ type: 'exit', workerId }),
      onError: (message) => void fail(`worker ${slot.slug}`, new Error(message)), // tmux / iTerm missing or refused: the error bar
    });
  }
```

Replace the `/hooks/event` route and its comment:

```ts
  // Answers only after the dispatch: the worker's hook blocks until curl returns, so the state (a PR seen on
  // PostToolUse, above all) is applied before the worker goes on. A Stop with the PR open is the end of the task:
  // the session is killed after the answer and its exit frees the slot. Unknown to the pool: a previous Hive's worker, nothing to do.
  app.post('/hooks/event', async (req: Request, res: Response) => {
    const workerId = req.header('x-hive-worker');
    const payload = req.body as HookPayload | undefined;
    if (workerId && payload?.hook_event_name) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const tokens = await turnTokens(workerId, payload);
      await dispatch({ type: 'hook', workerId, payload, branch, tokens });
    }
    res.sendStatus(200);
    if (workerId && payload?.hook_event_name === 'Stop' && slotOf(workerId)?.status === 'aguardando_review') pool.kill(workerId);
  });
```

`/hooks/exit` comment → `// The worker's command line ends with a curl here (both modes). Unknown to the pool (started by a previous Hive): free the slot ourselves.`

Delete the whole `app.post('/slots/:id/input', …)` handler. In `/slots/:id/focus`: `NO_TAB_MESSAGE` → `NO_WORKER_MESSAGE`, and on the 500 line add `// the terminal could not open: the message is the one the OS gave`.

- [ ] **Step 15: `src/transcript.ts`** — drop the `export` from `parseLine` and `TranscriptLine`, and the `result?` field with its comment (nothing outside the module reads them since T4).

- [ ] **Step 16: Run tests to verify they pass** — `pnpm test`, all PASS, 228 total (`spawn` −3, `workers` −1, `orchestrator` −2, `server` −1). Also: `grep -rn "onLine\|userMessage\|workerArgv\|spawnEmbeddedWorker\|'idle'\|/input\|RESULT_LINE\|QUESTION_MAX" src test` → no hits; `grep -n "stdin\|print mode" src/*.ts` → only `hooks-settings.ts` (`postStdin`, the curl helper).

- [ ] **Step 17: Commit**

```bash
git add src/types.ts src/workers.ts src/spawn.ts src/spawn-iterm.ts src/spawn-tmux.ts src/orchestrator.ts src/server.ts src/transcript.ts test/fakes.ts test/workers.test.ts test/spawn.test.ts test/spawn-tmux.test.ts test/orchestrator.test.ts test/server.test.ts
git commit -m "feat: embedded workers are interactive tmux sessions; the panel is detail only"
```

---

### Task 6: UI — `terminal` on the card, no input line, polling in both modes; README

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`, `README.md`

`node:test` cannot cover the DOM; the verification is the manual check in Step 4 (the spec's "Critério de pronto").

- [ ] **Step 1: `src/ui/index.html`**

CSS — delete lines 66–69:

```css
  #detail .row { display: flex; gap: 8px; margin-top: 8px; }
  body[data-workers=iterm] #output { display: none; }
  body:not([data-workers=iterm]) #focus { display: none; }
  #detail .row input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
```

(`#setup .row` rules stay: the setup form still uses `.row`.) No new CSS: the card's `terminal` button takes the default `button` style next to `kill` inside `.card .actions`.

Setup form — the `workers-mode` options (lines 167–168):

```html
            <option value="embedded">embutidos (sessão tmux; terminal pelo botão do card)</option>
            <option value="iterm">tabs do iTerm2 (macOS)</option>
```

Hint (line 172): replace everything from `Workers embutidos rodam em modo print` to the end of the `<div class="hint">` with:

```html
Permissões e perguntas são respondidas no terminal do worker (botão <code>terminal</code> no card). O modo embutido precisa do <code>tmux</code> (<code>brew install tmux</code> / <code>apt install tmux</code>).</div>
```

Detail panel — delete lines 202–205 (the `<div class="row">` with `#input` and `#send`). `#output` and the `#focus` / `#close` actions stay.

- [ ] **Step 2: `src/ui/app.ts`**

Delete `INPUT_PLACEHOLDER` and `ANSWER_PLACEHOLDER` (lines 14–15). In `renderCard`, the actions line:

```ts
      <div class="actions"><button data-focus="${slot.id}">terminal</button><button class="danger" data-kill="${slot.id}">kill</button></div>
```

Delete `workersMode`, `applyWorkersMode` and its comment (lines 148–153) and the two `applyWorkersMode();` calls (in `saveSetup` after `setupInfo = await getJson…` and in `init`). `syncOutputPolling`:

```ts
// One timer, for the selected slot only: opening the panel starts it, closing or switching restarts it clean.
function syncOutputPolling(slotId: string | undefined): void {
  if (slotId === outputSlotId) return;
  if (outputTimer) clearInterval(outputTimer);
  outputTimer = undefined;
  outputSlotId = slotId;
  $('output').innerHTML = '';
  lastOutput = '';
  if (!slotId) return;
  void loadOutput();
  outputTimer = setInterval(() => void loadOutput(), OUTPUT_POLL_MS);
}
```

Delete `sendInput` and, in `renderDetail`, the `$<HTMLInputElement>('input').placeholder = …` line. In the `grid` click listener, before the `kill` branch:

```ts
  const focusId = target.dataset.focus;
  if (focusId) {
    event.stopPropagation(); // opens the terminal, not the panel
    post(`/slots/${focusId}/focus`);
    return;
  }
```

Delete the `$('send').addEventListener(…)` and `$('input').addEventListener(…)` blocks. `$('focus')` (panel) and `$('close')` listeners stay. `WorkersMode` stays imported (the form cast uses it).

- [ ] **Step 3: `README.md`**

Line 5, last sentence → `Click a card for the details and \`terminal\` to open its session; Hive observes (through Claude Code hooks) and schedules.`

Line 7 →

```md
Workers run in one of two modes, chosen in the setup form (`workers` in the config): **embedded** (default) — an interactive `claude` in a detached `tmux` session owned by the Hive (`tmux -L hive`), opened in your terminal on demand (`terminal` on the card), macOS and Linux; or **iterm** — one iTerm2 tab per worker, macOS only. Both are real interactive sessions: permissions and questions are answered in the terminal.
```

Diagram line 18 → `  │ Agent Hive │ ───────▶ │ claude --worktree=<task> (tmux session) │` (keep the box aligned: pad the other box lines to the same width).

Step 2 (line 27) →

```md
2. Each worker is an interactive `claude --worktree=<slug>` in a `tmux` session of the Hive, started with the rendered prompt and a `hooks.json` injected via `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop` and `SessionEnd` each `curl` the Hive.
```

Step 4 (line 29) → `4. A session ending frees the slot (a \`Stop\` with the PR open ends it); a task without a PR goes back to the queue.`

Requirements (line 33) → `Requirements: macOS or Linux, Node 24+, pnpm, \`claude\` (Claude Code), \`tmux\` for the embedded mode (\`brew install tmux\` / \`apt install tmux\`), and \`gh\` logged in (GitHub boards only; run \`gh auth refresh -s project\` once).`

Usage (line 51) → `On screen: \`N/M workers ativos\`, the \`máx. workers\` field (changes live and persists across restarts), the queue, and one card per slot. Click a card to see the pending question or the PR link, the worktree and branch and an excerpt of the transcript; \`terminal\` opens the worker's session in a terminal (iTerm2 or Terminal.app on macOS, \`$TERMINAL\` on Linux) to answer permissions and questions; \`kill\` stops the worker and returns the task to the queue.`

Line 53: `or someone sends it a message from its card` → `or someone types in its terminal`.

Config table (line 105) → ``| `claudeArgs` | `[]` | file (e.g. `["--permission-mode", "acceptEdits"]`) |``

Known limitations: replace the first two bullets with one:

```md
- The panel shows an excerpt of the transcript; the session is the terminal (`terminal` on the card). A Hive restart does not readopt live sessions: it kills them and requeues their tasks.
```

- [ ] **Step 4: Manual check (PR test plan)** — `pnpm test` (228, unchanged) then `pnpm start <scratch repo>` with `maxConcurrent: 1`, one task in the queue, `tmux` installed, signal set to green:
  1. The card turns green and nothing opens; `tmux -L hive ls` lists `hive-<id>-<slug>`.
  2. `terminal` on the card opens an iTerm2 tab (or a Terminal.app window without iTerm2) attached to the session with the interactive `claude`; the panel does not open. "ir pro terminal" in the panel does the same.
  3. A permission request shows on the card as `esperando você`; approving it in the tab brings it back to `trabalhando`.
  4. The panel shows the transcript excerpt (text, `▶ tool` lines, `Edit` diffs) and no input line; the same with `workers: "iterm"`.
  5. After `gh pr create` and the end of the turn, the slot empties by itself and `tmux -L hive ls` no longer lists the session.
  6. `kill` on the card kills the session and returns the task to the queue; closing the Hive kills every session.
  7. Without `tmux` on PATH (`PATH=/usr/bin pnpm start …` or a renamed binary): the error bar reads `worker <slug>: tmux: spawn tmux ENOENT` and the slot frees.

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html src/ui/app.ts README.md
git commit -m "feat(ui): terminal button on the card, no input line; README for the tmux mode"
```
