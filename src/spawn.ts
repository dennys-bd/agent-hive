import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENTS } from './agents.js';
import { shimDir } from './shim.js';
import { historyPath } from './terminal-files.js';
import type { Activity, AgentId, Stage, Exec, SessionCopy, SessionPolicy, Item, PtyLaunch } from './types.js';

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

// Every prompt claude reads is this file's content as its last argv word ("$(cat file)"), so one starting with a dash (a transition's prompt
// opening on {verdict}, an agent's evidence) would be parsed as a flag: a neutral line goes first
const PROMPT_LEAD = 'Your instructions follow.';
const argvSafe = (text: string): string => (text.trimStart().startsWith('-') ? `${PROMPT_LEAD}\n\n${text}` : text);

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, argvSafe(text));
  return path;
}

/** The argv the reducer decided: the global claudeArgs, the stage model behind the agent's flag, as typed (#516), then the session id as
 * `--session-id` (new: the Hive generated it) or `--resume` (continue: the activity's own). No id at all leaves the choice to claude. The
 * worktree is not here: the Hive created it and the worker is started inside it (PtyLaunch.cwd). */
export function runArgs(activity: Pick<Activity, 'sessionId'>, stage: Pick<Stage, 'model'>, session: SessionPolicy, claudeArgs: string[], agent: AgentId): string[] {
  const model = stage.model === undefined ? [] : [AGENTS[agent].modelFlag, stage.model];
  const id = activity.sessionId === undefined ? [] : [session === 'continue' ? '--resume' : '--session-id', activity.sessionId];
  return [...claudeArgs, ...model, ...id];
}

/** A copy's argv (#587): the source session resumed as a new one under the id the reducer chose, so the new transcript and its SessionStart
 * carry that id. claudeArgs first, as runArgs puts them; a free session has no model. The dialog's name becomes the fork's own title in
 * place of the source's it would carry, so the session has one name; `--name=` so a name starting with `-` is never an option. */
export const copyArgs = (copy: SessionCopy, sessionId: string, claudeArgs: string[]): string[] =>
  [...claudeArgs, '--resume', copy.from, '--fork-session', '--session-id', sessionId, ...(copy.name === undefined ? [] : [`--name=${copy.name}`])];

/** A run's own temp dir (#428): TMPDIR for everything the run starts, removed when it exits. Under the daemon's own temp dir, which the OS
 * purges, so the dir of a run a daemon crash interrupted still goes eventually. */
export function runTmpDir(ptyId: string, base = tmpdir()): string {
  return join(base, 'hive-runs', ptyId);
}

/** The Hive's own env minus what a child must not inherit (see ptyEnv); a language server (#780) is started with the same. */
export function withoutHiveEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDECODE: _claudecode, CLAUDE_CODE_CHILD_SESSION: _childSession, NODE_PATH: _nodePath, HIVE_SECRET: _secret, HIVE_HOME: _home, ...env } = base;
  return env;
}

/**
 * The env the worker gets: the Hive's own minus CLAUDECODE (a Hive
 * launched from inside Claude Code would stop the child from starting), CLAUDE_CODE_CHILD_SESSION (inherited, it turns the worker's
 * transcript saving off) and NODE_PATH (Electron points it at the Hive's
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
 * dir first on PATH, so a `claude` typed there is the shim's. `path` is the workspace's PATH when it sets one (#738), else the Hive's. */
export function terminalEnv(home: string, terminalId: string, path = process.env.PATH ?? ''): Record<string, string> {
  return { HISTFILE: historyPath(home, terminalId), PATH: path === '' ? shimDir(home) : `${shimDir(home)}:${path}` };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// A run command (#300, #353): its env exported, then the command itself echoed as `> <command>` in bright white, as pnpm prints a script,
// so the console shows what ran above its greyed output (redesign 05), then the line through the user's own shell, then the run's closing line with the command's
// exit code. The shell exits with that code after the trailer, so the pty's exit carries it to the console's status (#537). Nothing reads a
// keyboard (the console is read-only), so there is no trap and no interactive shell after it: the run ends when the command does.
const COMMAND_ECHO = `printf '\\033[97m> %s\\033[0m\\r\\n'`;
const CLOSING_LINE = `printf '\\r\\n── encerrado (código %s) ──\\r\\n' "$hive_code"`;
const commandLine = ({ command, env }: NonNullable<PtyLaunch['run']>): string =>
  `${Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)} && `).join('')}${COMMAND_ECHO} ${shellQuote(command)} && "\${SHELL:-sh}" -c ${shellQuote(command)}; hive_code=$?; ${CLOSING_LINE}; `;

// The one shell string of the repo (#283, #251), in three renders: the claude run, a terminal and a workspace's run command (#300). The
// pty host runs it through `sh -c`, so there is no argv to pass. Everything user-controlled goes through shellQuote:
// the args are the reducer's (runArgs), quoted one by one; a run command's line and env values are quoted whole, and its env names passed
// ENV_NAME in the parser and the form, since `export NAME=` cannot quote a name.
// --mcp-config takes several values: --settings right after it ends the list, or the prompt would be read as a second config.
export function ptyCommand(o: PtyLaunch): string {
  // The secret from hive.secret, whose path the env ptyEnv gave the run holds (#467): curl reads the header from the file, so neither
  // sh -c's argv nor curl's ever holds the value
  const trailer = `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-pty: ${o.ptyId}' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`; // #696: never through a proxy
  // A terminal (#283, #647): the user's shell in the worktree, not exec'd, so the trailer still reports its exit; or a run command, which ends with its command (#300, #353).
  if (o.terminal && o.run) return `cd ${shellQuote(o.cwd)} && ${commandLine(o.run)}${trailer}; exit "$hive_code"`;
  if (o.terminal) return `cd ${shellQuote(o.cwd)} && "\${SHELL:-sh}"; ${trailer}`;
  const claude = [
    `cd ${shellQuote(o.cwd)} &&`,
    `HIVE_PTY_ID=${o.ptyId} HIVE_PORT=${o.port} claude`,
    ...(o.mcpPath === undefined ? [] : [`--mcp-config ${shellQuote(o.mcpPath)}`]), // every claude run has the MCP (#99, #283)
    `--settings ${shellQuote(o.hooksPath)}`,
    `--plugin-dir ${shellQuote(o.pluginDir)}`, // the Hive's skills (/hive:new-spec …) and the agents they dispatch (#100)
    // the workspace's language servers (#803), a plugin of their own: Claude Code's LSP tool reads its .lsp.json at launch
    ...(o.lspPluginDir === undefined ? [] : [`--plugin-dir ${shellQuote(o.lspPluginDir)}`]),
    // the Hive's protocol (#167): how to end a stage, ask and give up, beside the tools it names instead of inside every prompt
    ...(o.protocolPath === undefined ? [] : [`${AGENTS.claude.protocolFlag} ${shellQuote(o.protocolPath)}`]),
    ...o.args.map(shellQuote),
    ...(o.promptPath === undefined ? [] : [`"$(cat ${shellQuote(o.promptPath)})"`]), // a session starts with no prompt (#164)
  ].join(' ');
  return `${claude}; ${trailer}`;
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
 * unique per run and free of regex metacharacters, carried in claude's own argv (the per-worker --mcp-config path, <ptyId>.mcp.json). Resolves true when pkill matched. */
export const killStray = (pattern: string, exec: Exec = execFileAsync): Promise<boolean> => matchProcess('pkill', pattern, exec);

/** Whether a process matching the pattern is still running: the tab's kill polls the pty id, dropDeadSessions polls the slug
 * (the user's own session line carries it inside the worktree path). */
export const isStrayAlive = (pattern: string, exec: Exec = execFileAsync): Promise<boolean> => matchProcess('pgrep', pattern, exec);
