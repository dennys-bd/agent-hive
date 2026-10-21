// The Hive's one headless agent run (#330): a prompt in on stdin, the agent's final answer out. It runs in a fresh temp folder of its own
// (mkdtemp: 0700), or, given cwd, in that folder with the temp folder holding only the schema and Codex's answer (#877); with readOnlyTools
// the agent reads but nothing is written to a worktree. Ask the agent (#330) and the template reviewer (#328) pass no cwd, so no repository's
// CLAUDE.md / AGENTS.md reaches them; an evaluation (#877) passes the task's worktree, where Claude Code runs --restricted (the worktree's own
// settings and hooks never load, nor its CLAUDE.md, which the prompt names instead). Each agent's flags and answer are its runner's.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from './agents.js';
import { runners } from './agents/registry.js';
import { type Ran, runCapped } from './format-run.js';
import { withoutHiveEnv } from './spawn.js';
import type { AgentId } from './types.js';

export const HEADLESS_TIMEOUT_MS = 180_000;
const SCHEMA_FILE = 'schema.json';
const ANSWER_FILE = 'answer.txt';
const FILE_MODE = 0o600; // the schema; the folder's 0700 already keeps the answer this user's

// timeoutMs: the run's own (#877); HeadlessDeps.timeoutMs, the tests' override, still wins over it
export interface HeadlessInput { agent: AgentId; model?: string; prompt: string; schema: object; signal: AbortSignal; cwd?: string; readOnlyTools?: true; timeoutMs?: number }
export type HeadlessResult = { answer: string } | { failure: string; detail: string };
/** Tests' seams: the env (a fake CLI first on its PATH), the folder the run's temp folder goes in, a shorter timeout. */
export interface HeadlessDeps { env?: NodeJS.ProcessEnv; tmpRoot?: string; timeoutMs?: number }

const DETAIL_TAIL = 2048;

// What the caller logs on a failure: the end of stderr, then of stdout. Only the end: codex exec echoes the whole prompt (the item's text)
// at the start of its stderr, which hive.log has no use for
const tail = (text: string): string => text.slice(-DETAIL_TAIL);
const detailOf = (ran: Ran): string => [tail(ran.stderr), tail(ran.stdout?.toString('utf8') ?? '')].filter((part) => part !== '').join('\n');

/** One headless run of `input.agent`. Never leaves its folder behind; throws only when the folder itself cannot be made or written. */
export async function runHeadless(input: HeadlessInput, deps: HeadlessDeps = {}): Promise<HeadlessResult> {
  const runner = runners[input.agent];
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'hive-headless-'));
  try {
    const schema = JSON.stringify(input.schema);
    const run = {
      dir, schema, schemaPath: join(dir, SCHEMA_FILE), answerPath: join(dir, ANSWER_FILE), ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.readOnlyTools ? { readOnlyTools: true as const } : {}),
    };
    await writeFile(run.schemaPath, schema, { mode: FILE_MODE });
    const proc = { command: AGENTS[input.agent].command, args: runner.headless(run), env: withoutHiveEnv(deps.env ?? process.env) };
    const ran = await runCapped(proc, input.prompt, input.cwd ?? dir, deps.timeoutMs ?? input.timeoutMs ?? HEADLESS_TIMEOUT_MS, input.signal);
    if (ran.failure !== undefined) return { failure: ran.failure, detail: detailOf(ran) };
    const answerFile = await readFile(run.answerPath, 'utf8').catch(() => undefined); // only Codex writes one
    const answer = runner.headlessAnswer(ran.stdout?.toString('utf8') ?? '', answerFile);
    return answer === undefined ? { failure: 'no answer', detail: detailOf(ran) } : { answer };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
