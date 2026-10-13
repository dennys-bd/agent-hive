import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runners } from './agents/registry.js';
import type { AgentRun } from './agents/runner.js';
import { shellQuote } from './shell-init.js';
import { shimDir } from './shim.js';
import { historyPath } from './terminal-files.js';
import { AGENT_IDS, type Stage, type Exec, type SessionPolicy, type Item, type LaunchArg, type PtyLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const NO_MATCH_EXIT = 1;

// {id} {number} {title} {body} {url}, {verdict} {feedback} (#134), or {result.<dotted path>} into the task's result (#99). One pass: text a
// substitution brings in (a task body that says `{result.spec}`, an evidence that says `{id}`) is never read as a placeholder.
const PLACEHOLDER = /\{(?:(id|number|title|body|url|verdict|feedback)|result\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))\}/g;

// Own keys of objects only: `{result.spec.length}` or `{result.constructor}` are missing, never a property of a string or a prototype.
function resultAt(result: Record<string, unknown> | undefined, path: string): string {
  const value = path.split('.').reduce<unknown>(
    (at, key) => (typeof at === 'object' && at !== null && Object.hasOwn(at, key) ? (at as Record<string, unknown>)[key] : undefined),
    result,
  );
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** vars: what a transition renders beside the item (#134): its verdict's text and the user's feedback; empty when absent. */
export function renderPrompt(template: string, item: Item, result?: Record<string, unknown>, vars: { verdict?: string; feedback?: string } = {}): string {
  const values: Record<string, string> = {
    id: item.id, number: item.id, title: item.title, body: item.body, url: item.url, // {number} is a synonym of {id}
    verdict: vars.verdict ?? '', feedback: vars.feedback ?? '',
  };
  return template.replace(PLACEHOLDER, (_match, key: string | undefined, path: string | undefined) =>
    (key !== undefined ? values[key] : resultAt(result, path ?? '')));
}

/** Appended to the stage prompt when the popup's toggle asked for it (#131): the base the worktree branches from and where the PR goes. */
export function stackedPrLine(ref: string): string {
  return `\n\nThis worktree branches from ${ref}, not from the default base. Open the pull request against ${ref} (stacked PR).`;
}

/** A stage with verdicts tells its run which ones hive_done takes (#134): a line of its own after the stage's prompt. English, agent-neutral. */
export const verdictsLine = (stage: Pick<Stage, 'verdicts'>): string =>
  (stage.verdicts === undefined || stage.verdicts.length === 0 ? ''
    : `\n\nThis stage ends with a verdict: call hive_done with "verdict" set to one of ${stage.verdicts.map((v) => JSON.stringify(v)).join(', ')}, and the evidence behind it as "evidence".`);

/** What a stage end asks of its session when the next stage asks for a handoff (#692): English and agent-neutral, like CONTINUE_PROMPT. It
 * reaches the session through feedback's paths (a Stop answered in place, a session typed into, a queued handover) without feedback's lead. */
export const HANDOFF_PROMPT = 'The next stage starts in a new session and needs a handoff from this one. Write it: the task, the branch, the files that carry the work, the decisions taken and why, what is done, what is left and what the next session must not miss. Then call hive_done with { "handoff": "<text>" }.';

/** A handoff stage's new session reads the previous stage's handoff before its own prompt (#692). Any other run, or no handoff text: the
 * prompt as it is. */
export function withHandoff(prompt: string, stage: Pick<Stage, 'handoff'>, result: Record<string, unknown> | undefined, session: SessionPolicy): string {
  const handoff = result?.handoff;
  if (stage.handoff !== true || session !== 'new' || typeof handoff !== 'string' || handoff.trim() === '') return prompt;
  return `Handoff from the previous stage:\n\n${handoff}\n\n---\n\n${prompt}`;
}

// Every prompt an agent reads is this file's content as its last argv word ("$(cat file)"), so one starting with a dash (a transition's prompt
// opening on {verdict}, an agent's evidence) would be parsed as a flag: a neutral line goes first
const PROMPT_LEAD = 'Your instructions follow.';
const argvSafe = (text: string): string => (text.trimStart().startsWith('-') ? `${PROMPT_LEAD}\n\n${text}` : text);

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, argvSafe(text));
  return path;
}

/** A run's session as its runner reads it (#924): continue resumes the id, new starts under it (the Hive generated it); no id at all leaves the
 * choice to the agent. The worktree is not here: the Hive created it and the run starts inside it (PtyLaunch.cwd). */
export const runSession = (sessionId: string | undefined, policy: SessionPolicy): AgentRun['session'] =>
  (sessionId === undefined ? undefined : { id: sessionId, resume: policy === 'continue' });

/** A run's own temp dir (#428): TMPDIR for everything the run starts, removed when it exits. Under the daemon's own temp dir, which the OS
 * purges, so the dir of a run a daemon crash interrupted still goes eventually. */
export function runTmpDir(ptyId: string, base = tmpdir()): string {
  return join(base, 'hive-runs', ptyId);
}

// The Hive's own variables no child inherits (see ptyEnv); every runner's hostEnv joins them (#924)
const HIVE_ONLY_ENV = ['NODE_PATH', 'HIVE_SECRET', 'HIVE_HOME'];

/** The Hive's own env minus what a child must not inherit (see ptyEnv): every runner's host env, whatever the run's agent, since it
 * describes the process the Hive was started from (#924). A language server (#780) is started with the same. */
export function withoutHiveEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dropped = new Set([...AGENT_IDS.flatMap((id) => runners[id].hostEnv), ...HIVE_ONLY_ENV]);
  return Object.fromEntries(Object.entries(base).filter(([name]) => !dropped.has(name)));
}

/**
 * The env the worker gets: the Hive's own minus every runner's host env (Claude's CLAUDECODE: a Hive
 * launched from inside Claude Code would stop the child from starting; CLAUDE_CODE_CHILD_SESSION: inherited, it turns the worker's
 * transcript saving off), NODE_PATH (Electron points it at the Hive's
 * node_modules; inherited, a worker running `pnpm test` would resolve the Hive's electron and open a window that never
 * exits), plus the pty id, the port and the path of hive.secret, whose header line curl sends with -H @file (#467: the value in a
 * variable would be expanded into curl's argv, which every account reads through ps; a stray HIVE_SECRET is dropped too), and TMPDIR
 * pointing at the run's own dir (#428), so whatever its tools leave there goes with it. HIVE_HOME is dropped too: a worker running the
 * Hive's own tests or the `hive` CLI would otherwise act on its daemon's home instead of a home of its own (#105).
 */
export function ptyEnv(base: NodeJS.ProcessEnv, ptyId: string, port: number, tmpDir: string, secretFile: string): NodeJS.ProcessEnv {
  return { ...withoutHiveEnv(base), TMPDIR: tmpDir, HIVE_PTY_ID: ptyId, HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile };
}

/** What a kept terminal's shell gets on top of ptyEnv (#696): a history file of its own, kept with it until it is forgotten, and the Hive's bin
 * dir first on PATH, so an agent typed there is its shim's (#924). `path` is the workspace's PATH when it sets one (#738), else the Hive's. */
export function terminalEnv(home: string, terminalId: string, path = process.env.PATH ?? ''): Record<string, string> {
  return { HISTFILE: historyPath(home, terminalId), PATH: path === '' ? shimDir(home) : `${shimDir(home)}:${path}` };
}

// A run command (#300, #353): its env exported, then the command itself echoed as `> <command>` in bright white, as pnpm prints a script,
// so the console shows what ran above its greyed output (redesign 05), then the line through the user's own shell, then the run's closing line with the command's
// exit code. The shell exits with that code after the trailer, so the pty's exit carries it to the console's status (#537). Nothing reads a
// keyboard (the console is read-only), so there is no trap and no interactive shell after it: the run ends when the command does.
const COMMAND_ECHO = `printf '\\033[97m> %s\\033[0m\\r\\n'`;
const CLOSING_LINE = `printf '\\r\\n── encerrado (código %s) ──\\r\\n' "$hive_code"`;
const commandLine = ({ command, env }: NonNullable<PtyLaunch['run']>): string =>
  `${Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)} && `).join('')}${COMMAND_ECHO} ${shellQuote(command)} && "\${SHELL:-sh}" -c ${shellQuote(command)}; hive_code=$?; ${CLOSING_LINE}; `;

// A launch word as the shell reads it (#924): one of the Hive's own flags bare with its value quoted, any other word quoted whole, as the
// command line always had them
const shellWord = (arg: LaunchArg): string => (typeof arg === 'string' ? shellQuote(arg) : `${arg[0]} ${shellQuote(arg[1])}`);

// The one shell string of the repo (#283, #251), in three renders: an agent's run, a terminal and a workspace's run command (#300). The
// pty host runs it through `sh -c`, so there is no argv to pass. Everything user-controlled goes through shellQuote: the agent's argv, which
// its runner rendered (#924), word by word; a run command's line and env values are quoted whole, and its env names passed ENV_NAME in the
// parser and the form, since `export NAME=` cannot quote a name.
export function ptyCommand(o: PtyLaunch): string {
  // The secret from hive.secret, whose path the env ptyEnv gave the run holds (#467): curl reads the header from the file, so neither
  // sh -c's argv nor curl's ever holds the value
  const trailer = `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-pty: ${o.ptyId}' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`; // #696: never through a proxy
  // A terminal (#283, #647): the user's shell in the worktree, not exec'd, so the trailer still reports its exit; or a run command, which ends with its command (#300, #353).
  if (o.terminal && o.run) return `cd ${shellQuote(o.cwd)} && ${commandLine(o.run)}${trailer}; exit "$hive_code"`;
  if (o.terminal) return `cd ${shellQuote(o.cwd)} && "\${SHELL:-sh}"; ${trailer}`;
  if (o.agent === undefined) throw new Error('pty: a run launch with no agent');
  const line = [
    `cd ${shellQuote(o.cwd)} &&`,
    `HIVE_PTY_ID=${o.ptyId} HIVE_PORT=${o.port} ${o.agent.command}`, // an AGENTS constant, never the user's text: bare, as it always was
    ...o.agent.argv.map(shellWord),
    ...(o.promptPath === undefined ? [] : [`"$(cat ${shellQuote(o.promptPath)})"`]), // a session starts with no prompt (#164)
  ].join(' ');
  return `${line}; ${trailer}`;
}

// pkill / pgrep by a pattern the caller owns: true when a process matched; exit 1 is "nothing matched", anything else throws.
async function matchProcess(tool: 'pkill' | 'pgrep', pattern: string, exec: Exec): Promise<boolean> {
  try {
    await exec(tool, ['-f', '--', pattern]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}

/** Boot-only orphan defense (and the tab's kill): kills a worker still holding a worktree. The pattern is the pty id — a uuid,
 * unique per run and free of regex metacharacters, carried in the agent's own argv (the per-worker MCP config path, <ptyId>.mcp.json). Resolves true when pkill matched. */
export const killStray = (pattern: string, exec: Exec = execFileAsync): Promise<boolean> => matchProcess('pkill', pattern, exec);

/** Whether a process matching the pattern is still running: the tab's kill polls the pty id, dropDeadSessions polls the slug
 * (the user's own session line carries it inside the worktree path). */
export const isStrayAlive = (pattern: string, exec: Exec = execFileAsync): Promise<boolean> => matchProcess('pgrep', pattern, exec);
