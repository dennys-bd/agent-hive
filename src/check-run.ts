// A command-line checker's run (#782): its binary with an argv, never a shell, in the activity's folder with nothing on stdin, in a process group
// of its own (cargo and mix start children the timeout must reach); its report read from stdout, stderr or a file, capped, then parsed. A linter
// exits non-zero when it finds something, so a failure is a spawn error, the timeout, the cap, a report that does not read, or a non-zero exit
// with no finding read. Every run is a console run of its checker's channel.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheck } from './checker-parse.js';
import { checkArgv, type CliCheckerDef } from './checkers.js';
import { checkChannel, type ConsoleStore, crlf, failLine, runHeader } from './console.js';
import { collect, killGroup } from './format-run.js';
import { findCandidate } from './formatter-detect.js';
import { CHECK_OUTPUT_MAX, CHECK_TIMEOUT_MS, type CheckAnswer, type CheckDiagnostic, type FormatLog } from './types.js';

export interface CheckContext {
  folder: string; // the activity's folder, a real path: the cwd, and what the report's paths resolve against
  file: string; // the saved file's absolute path
  args: readonly string[]; // the user's extra arguments, after the subcommand
  env: NodeJS.ProcessEnv; // the daemon's without the Hive's own, the workspace's on top; never logged
  workspace: string; // the console channel's
  label: string; // the run header's text: `#<task> · <target>`, or `<workspace> · <target>` for a local activity
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  signal: AbortSignal; // a newer run of the same target aborts this one
  timeoutMs?: number; // CHECK_TIMEOUT_MS unless a test shortens it
  maxBytes?: number; // CHECK_OUTPUT_MAX unless a test shortens it
}
/** The runs in flight (#782), keyed by activity, checker and target: a new one aborts the one before. */
export interface CheckRuns {
  start(key: string): AbortSignal;
  end(key: string, signal: AbortSignal): void;
  /** A slot to spawn in, among at most MAX_CONCURRENT_CHECKS for the whole daemon (#782): resolves its release, or undefined when the run was superseded while it waited. */
  slot(signal: AbortSignal): Promise<(() => void) | undefined>;
}
const MAX_CONCURRENT_CHECKS = 4; // a save in a big monorepo must not fork a dozen type checkers at once

interface Ran { stdout: string; stderr: string; code: number | null; failure?: string; isSuperseded?: boolean }
const REPORT = 'report.sarif';

const exited = (code: number | null, signal: NodeJS.Signals | null): Pick<Ran, 'code' | 'failure'> =>
  (code !== null ? { code } : { code, failure: signal === null ? 'failed to run' : `killed by ${signal}` });

// The process to its end: the timer, the cap and a newer run each kill its group at once and settle
function run(id: string, command: string, args: string[], ctx: CheckContext): Promise<Ran> {
  return new Promise((resolve) => {
    let settled = false;
    const max = ctx.maxBytes ?? CHECK_OUTPUT_MAX;
    const timeoutMs = ctx.timeoutMs ?? CHECK_TIMEOUT_MS;
    const child = spawn(command, args, { cwd: ctx.folder, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stop = (failure: string | undefined, isSuperseded = false): void => {
      if (settled) return; // once reaped, the pid may be another group's
      killGroup(child.pid);
      settle({ stdout: '', stderr: stderr().toString('utf8'), code: null, ...(failure === undefined ? {} : { failure }), isSuperseded });
    };
    const over = (): void => stop(`output over ${max} bytes`);
    const stdout = collect(child.stdout, max, over);
    const stderr = collect(child.stderr, max, over);
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = (): void => stop(undefined, true);
    function settle(ran: Ran): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve(ran);
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort(); // aborted while the binary was looked up
    child.on('error', (err: NodeJS.ErrnoException) => settle({ stdout: '', stderr: '', code: null, failure: err.code === 'ENOENT' ? `${id} not found` : `failed to run (${err.code ?? 'unknown'})` }));
    child.on('close', (code, signal) => settle({ stdout: stdout().toString('utf8'), stderr: stderr().toString('utf8'), ...exited(code, signal) }));
  });
}

function reportOf(def: CliCheckerDef, ran: Ran, dir: string | undefined, max: number): Promise<string> {
  if (def.output === 'stderr') return Promise.resolve(ran.stderr);
  if (def.output === 'file') return dir === undefined ? Promise.resolve('') : readReport(join(dir, REPORT), max);
  return Promise.resolve(ran.stdout);
}

// The tool's own file is not capped by the pipes' collector: stat before reading, so a huge report is never held in memory
async function readReport(path: string, max: number): Promise<string> {
  const size = await stat(path).then((s) => s.size, () => 0);
  if (size > max) throw new Error(`output over ${max} bytes`);
  return readFile(path, 'utf8').catch(() => '');
}

// A finished run as its diagnostics, or why it failed. ponytail: a non-zero exit whose every finding lay outside the folder reads as a failure;
// count the findings before the path filter if a tool ever does that
async function outcomeOf(def: CliCheckerDef, ctx: CheckContext, ran: Ran, dir: string | undefined): Promise<{ diagnostics: CheckDiagnostic[] } | { failure: string }> {
  if (ran.failure !== undefined) return { failure: ran.failure };
  const report = await reportOf(def, ran, dir, ctx.maxBytes ?? CHECK_OUTPUT_MAX).catch((err: Error) => err);
  if (report instanceof Error) return { failure: report.message };
  const parsed: CheckDiagnostic[] | { error: string } = report.trim() === '' ? [] : parseCheck(def.format, report, ctx.folder, { file: ctx.file });
  if ('error' in parsed) return { failure: parsed.error };
  if (ran.code !== 0 && parsed.length === 0) return { failure: `exit code ${ran.code}` };
  return { diagnostics: parsed };
}

async function finish(def: CliCheckerDef, ctx: CheckContext, ran: Ran, dir: string | undefined, log: FormatLog): Promise<CheckAnswer> {
  const append = (text: string): void => ctx.consoleStore.append(log.run, text);
  if (ran.isSuperseded) {
    append(crlf('superseded by a newer run\n'));
    ctx.consoleStore.end(log.run, 0);
    return { state: 'superseded' };
  }
  if (ran.stderr !== '' && def.output !== 'stderr') append(crlf(ran.stderr)); // markdownlint's report is its stderr: not its log
  const outcome = await outcomeOf(def, ctx, ran, dir);
  if ('failure' in outcome) {
    append(`${failLine(outcome.failure)}\r\n`);
    ctx.consoleStore.end(log.run, 1);
    return { state: 'failed', reason: outcome.failure, log };
  }
  ctx.consoleStore.end(log.run, 0);
  return { state: 'done', scope: def.scope, diagnostics: outcome.diagnostics, log };
}

/** One run of a command-line checker for `ctx.file` (#782), logged as a run of its console channel: the header, the tool's stderr and, on a
 * failure, the reason in red. absent, before any console run, when no candidate is installed for the folder. Never throws on the tool's behalf. */
export async function runCheck(def: CliCheckerDef, ctx: CheckContext): Promise<CheckAnswer> {
  const binary = await findCandidate(def.candidates, ctx.folder, ctx.env.PATH ?? '');
  if (binary === undefined) return { state: 'absent' };
  if (ctx.signal.aborted) return { state: 'superseded' };
  const channel = checkChannel(ctx.workspace, def.id);
  const log: FormatLog = { channel: channel.id, run: randomUUID() };
  ctx.consoleStore.begin(channel, log.run, runHeader(ctx.label, new Date()));
  let dir: string | undefined;
  try {
    dir = def.output === 'file' ? await mkdtemp(join(tmpdir(), 'hive-check-')) : undefined;
    const ran = await run(def.id, binary, checkArgv(def, ctx.args, ctx.file, dir === undefined ? '' : join(dir, REPORT)), ctx);
    return await finish(def, ctx, ran, dir, log);
  } catch (err) {
    // the run is already open in the console: an I/O throw ends it as failed rather than leaving it running
    const reason = `failed to run (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`;
    ctx.consoleStore.append(log.run, `${failLine(reason)}\r\n`);
    ctx.consoleStore.end(log.run, 1);
    return { state: 'failed', reason, log };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The daemon's runs in flight (#782): starting one aborts the run of the same key, which then answers superseded. */
export function createCheckRuns(limit = MAX_CONCURRENT_CHECKS): CheckRuns {
  const running = new Map<string, AbortController>();
  const waiting: { grant(release: (() => void) | undefined): void }[] = [];
  let active = 0;
  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next !== undefined) { active += 1; next.grant(release); }
  };
  return {
    start(key) {
      running.get(key)?.abort();
      const controller = new AbortController();
      running.set(key, controller);
      return controller.signal;
    },
    end(key, signal) {
      if (running.get(key)?.signal === signal) running.delete(key);
    },
    slot(signal) {
      if (signal.aborted) return Promise.resolve(undefined);
      if (active < limit) { active += 1; return Promise.resolve(release); }
      return new Promise((resolve) => {
        const entry = { grant: resolve };
        waiting.push(entry);
        signal.addEventListener('abort', () => {
          const at = waiting.indexOf(entry);
          if (at >= 0) { waiting.splice(at, 1); resolve(undefined); }
        }, { once: true });
      });
    },
  };
}
