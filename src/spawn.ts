import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { runners } from './agents/registry.js';
import type { AgentRun } from './agents/runner.js';
import { envValue, findExec } from './exec-path.js';
import { killTree } from './kill-tree.js';
import { shellInitDir, shellQuote } from './shell-init.js';
import { shimDir } from './shim.js';
import { commandFirst } from './stage-agent.js';
import { historyPath } from './terminal-files.js';
import { AGENT_IDS, type Stage, type Exec, type SessionPolicy, type Item, type LaunchArg, type PtyLaunch } from './types.js';
import { listProcesses, matching } from './win-procs.js';

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
  const lead = `Handoff from the previous stage:\n\n${handoff}`;
  const split = commandFirst(prompt); // #710: a slash command (/hive:<skill>) runs only at the start of the message, so the handoff follows it
  if (split === undefined) return `${lead}\n\n---\n\n${prompt}`;
  return split.rest === '' ? `${split.command}\n\n${lead}` : `${split.command}\n\n${lead}\n\n---\n\n${split.rest}`;
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
// HIVE_PWSH too (#645): only terminalEnv sets it, so an inherited one never picks the terminal's shell
const HIVE_ONLY_ENV = ['NODE_PATH', 'HIVE_SECRET', 'HIVE_HOME', 'HIVE_PWSH'];

/** The Hive's own env minus what a child must not inherit (see ptyEnv): every runner's host env, whatever the run's agent, since it
 * describes the process the Hive was started from (#924). A language server (#780) is started with the same. */
export function withoutHiveEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = [...AGENT_IDS.flatMap((id) => runners[id].hostEnv), ...HIVE_ONLY_ENV];
  // a hostEnv name ending in * stands for a prefix (#333: Codex's HIVE_MCP_TOKEN_<i>, one per external server)
  const dropped = (name: string): boolean => names.some((n) => (n.endsWith('*') ? name.startsWith(n.slice(0, -1)) : name === n));
  return Object.fromEntries(Object.entries(base).filter(([name]) => !dropped(name)));
}

/**
 * The env the worker gets: the Hive's own minus every runner's host env (Claude's CLAUDECODE: a Hive
 * launched from inside Claude Code would stop the child from starting; CLAUDE_CODE_CHILD_SESSION: inherited, it turns the worker's
 * transcript saving off), NODE_PATH (Electron points it at the Hive's
 * node_modules; inherited, a worker running `pnpm test` would resolve the Hive's electron and open a window that never
 * exits), plus the pty id, the port and the path of hive.secret, whose header line curl sends with -H @file (#467: the value in a
 * variable would be expanded into curl's argv, which every account reads through ps; a stray HIVE_SECRET is dropped too), and TMPDIR
 * pointing at the run's own dir (#428), so whatever its tools leave there goes with it. On win32 TEMP and TMP point there too (#644): Windows
 * tools and node's os.tmpdir() read them, not TMPDIR. HIVE_HOME is dropped too: a worker running the
 * Hive's own tests or the `hive` CLI would otherwise act on its daemon's home instead of a home of its own (#105).
 */
export function ptyEnv(base: NodeJS.ProcessEnv, ptyId: string, port: number, tmpDir: string, secretFile: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const windowsTemp = platform === 'win32' ? { TEMP: tmpDir, TMP: tmpDir } : {};
  return { ...withoutHiveEnv(base), TMPDIR: tmpDir, ...windowsTemp, HIVE_PTY_ID: ptyId, HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile };
}

/** What a kept terminal's shell gets on top of ptyEnv (#696): a history file of its own, kept with it until it is forgotten, the Hive's bin
 * dir first on PATH, so an agent typed there is its shim's (#924) for a child process too, and HIVE_SHELL_DIR, the init files' folder
 * ptyCommand starts zsh, bash, fish and PowerShell on (#259, #645). `path` is the workspace's PATH when it sets one (#738), else the Hive's,
 * joined in `platform`'s own way. On win32 HIVE_PWSH names the PowerShell windowsShell found, which the terminal opens unless SHELL
 * names bash (#645). */
export interface TerminalEnvOptions { platform: NodeJS.Platform; pwsh?: string }

export function terminalEnv(home: string, terminalId: string, path: string, { platform, pwsh }: TerminalEnvOptions): Record<string, string> {
  const delimiter = platform === 'win32' ? win32.delimiter : posix.delimiter;
  const shell: Record<string, string> = platform === 'win32' && pwsh !== undefined ? { HIVE_PWSH: pwsh } : {};
  return { HISTFILE: historyPath(home, terminalId), PATH: path === '' ? shimDir(home) : `${shimDir(home)}${delimiter}${path}`, HIVE_SHELL_DIR: shellInitDir(home), ...shell };
}

// pwsh 7 first, then the powershell.exe every Windows ships (#645). Both install folders come before PATH, since an MSI install of 7 may
// leave a running Hive's PATH alone and a workspace's PATH is the repository's to choose
const PWSH_NAMES = ['pwsh', 'powershell'] as const;
// Only an .exe: a pwsh.cmd planted on a workspace's PATH would otherwise run on every terminal open
const EXE_ONLY = { PATHEXT: '.EXE' };
const fixedPath = (root: string | undefined, ...parts: string[]): string[] => (root !== undefined && win32.isAbsolute(root) ? [win32.join(root, ...parts)] : []);

/** The full path of the PowerShell a Windows terminal opens (#645), or undefined: none found, or not win32. Looked up on every launch,
 * never cached, as findExec always is: a PowerShell 7 installed while the Hive runs is picked up. */
export function windowsShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isFile?: (file: string) => boolean): string | undefined {
  if (platform !== 'win32') return undefined;
  const names = [
    ...fixedPath(envValue(env, 'PROGRAMFILES'), 'PowerShell', '7', 'pwsh'),
    ...fixedPath(envValue(env, 'SYSTEMROOT'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell'),
    ...PWSH_NAMES,
  ];
  for (const name of names) {
    const found = findExec(name, { platform, env: { ...env, ...EXE_ONLY }, isFile });
    if (found !== undefined) return found;
  }
  return undefined;
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

// The shell's name (#645): SHELL with everything up to its last / or \ removed and a trailing .exe dropped, so
// C:\Program Files\Git\bin\bash.exe and /usr/bin/bash both read bash. With HIVE_PWSH set (Windows) only an exported SHELL, the one the pty
// env carried: Git's sh.exe is bash, which sets an unset SHELL to the account's login shell without exporting it, and that would hide
// HIVE_PWSH. Without it, any SHELL, as before #645: macOS's and Linux's terminals keep the shell bash-as-sh fills in when the Hive's env has none.
const SHELL_NAME = `if [ -n "\${HIVE_PWSH:-}" ]; then case "$(export -p)" in *'export SHELL='*) hive_sh=\${SHELL##*[/\\\\]} ;; *) hive_sh= ;; esac; else hive_sh=\${SHELL##*[/\\\\]}; fi; hive_sh=\${hive_sh%.exe};`;

/** PowerShell's first command (#645): profile.ps1 read as text and dot-sourced as a scriptblock, which execution policy, applying to
 * script files only, never stops, and which runs in the global scope, so what the user's profiles define stays alive. One sh
 * single-quoted word with no quote inside; it reads only $env:HIVE_SHELL_DIR. UTF8, since 5.1 reads a BOM-less file as ANSI. */
export const PWSH_LOADER = '. ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $env:HIVE_SHELL_DIR pwsh/profile.ps1))))';

// A plain terminal's shell (#259): zsh, bash and fish start on the init files in HIVE_SHELL_DIR (terminalEnv), which run the user's own rc
// files and then define a function per agent calling its shim, so no PATH those files set hides it. zsh finds them through ZDOTDIR, the user's
// kept in HIVE_USER_ZDOTDIR for the files to put back; bash through --rcfile, which stands for ~/.bashrc; fish through -C, run after its
// config. Any other shell, with HIVE_PWSH set (Windows, #645), is PowerShell on the loader, which runs the user's profiles and then the
// same functions; else the plain $SHELL with the shim first on PATH, as with no HIVE_SHELL_DIR. Only the pty env's own values are
// expanded here, each one quoted. One group, so a failed cd skips all of it.
const TERMINAL_SHELL = [
  '{',
  SHELL_NAME,
  `case "\${HIVE_SHELL_DIR:+$hive_sh}" in`,
  `zsh) HIVE_USER_ZDOTDIR="\${ZDOTDIR-}" ZDOTDIR="$HIVE_SHELL_DIR/zsh" "$SHELL" ;;`,
  `bash) "$SHELL" --rcfile "$HIVE_SHELL_DIR/bash/rc" ;;`,
  `fish) "$SHELL" -C 'source "$HIVE_SHELL_DIR/fish/init.fish"' ;;`,
  `*) if [ -n "\${HIVE_PWSH:-}" ]; then "$HIVE_PWSH" -NoLogo -NoProfile -NoExit -Command '${PWSH_LOADER}'; else "\${SHELL:-sh}"; fi ;;`,
  'esac;',
  '}',
].join(' ');

// The one shell string of the repo (#283, #251), in three renders: an agent's run, a terminal, whose shell starts on the Hive's init files
// (#259), and a workspace's run command (#300). The pty host runs it through `sh -c`, so there is no argv to pass. Everything user-controlled
// goes through shellQuote: the agent's command (#633) and its argv, which its runner rendered (#924), word by word; a run command's line and env values are quoted
// whole, and its env names passed ENV_NAME in the parser and the form, since `export NAME=` cannot quote a name.
export function ptyCommand(o: PtyLaunch): string {
  // The secret from hive.secret, whose path the env ptyEnv gave the run holds (#467): curl reads the header from the file, so neither
  // sh -c's argv nor curl's ever holds the value
  const trailer = `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-pty: ${o.ptyId}' -H @"$HIVE_SECRET_FILE" --noproxy '*' >/dev/null`; // #696: never through a proxy
  // A terminal (#283, #647): the user's shell in the worktree, started on the Hive's init files (#259) and not exec'd, so the trailer still
  // reports its exit; or a run command, which ends with its command (#300, #353).
  if (o.terminal && o.run) return `cd ${shellQuote(o.cwd)} && ${commandLine(o.run)}${trailer}; exit "$hive_code"`;
  if (o.terminal) return `cd ${shellQuote(o.cwd)} && ${TERMINAL_SHELL}; ${trailer}`;
  if (o.agent === undefined) throw new Error('pty: a run launch with no agent');
  const line = [
    `cd ${shellQuote(o.cwd)} &&`,
    `HIVE_PTY_ID=${o.ptyId} HIVE_PORT=${o.port} ${shellQuote(o.agent.command)}`, // #633: on win32 an .exe's full path (spaces, backslashes); one rule on every OS
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

// win32 (#638): no pkill or pgrep. One listing of the table; every row whose line matches is killed with its tree (taskkill /T takes the
// agent's children too), all awaited. killTree never rejects, so a row whose parent this pass already killed is harmless.
async function killListed(pattern: string, exec: Exec): Promise<boolean> {
  const rows = matching(await listProcesses(exec), pattern);
  await Promise.all(rows.map((row) => killTree(row.pid, 'win32', exec)));
  return rows.length > 0;
}

const isListed = async (pattern: string, exec: Exec): Promise<boolean> => matching(await listProcesses(exec), pattern).length > 0;

/** Boot-only orphan defense (and the tab's kill): kills a worker still holding a worktree. The pattern is the runner's stray pattern, built
 * on the pty id (a uuid unique per run, carried in the agent's own argv: the per-worker MCP config path, <ptyId>.mcp.json). Resolves true
 * when a process matched. On win32 through the process listing (#638); a failed listing rejects there as a failed pkill does here. */
export const killStray = (pattern: string, exec: Exec, platform: NodeJS.Platform): Promise<boolean> =>
  (platform === 'win32' ? killListed(pattern, exec) : matchProcess('pkill', pattern, exec));

/** Whether a process matching the pattern is still running: the tab's kill polls the pty id, dropDeadSessions polls the slug
 * (the user's own session line carries it inside the worktree path). On win32 through the process listing (#638). */
export const isStrayAlive = (pattern: string, exec: Exec, platform: NodeJS.Platform): Promise<boolean> =>
  (platform === 'win32' ? isListed(pattern, exec) : matchProcess('pgrep', pattern, exec));
