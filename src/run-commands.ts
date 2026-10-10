import { TIMEOUT, timeoutMs } from './timeout.js';
import { CI_CHECKS, type CiChecks, ENV_NAME, ON_MISSING, RESERVED_ENV_NAMES, type Command, type CommandImpl, type OnMissing, type Stage } from './types.js';

// The Comb's run commands in hive.config.json (#300, #511), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE,
// written out: importing it would make config.ts, which calls this parser, and this file import each other.
const FILE = 'hive.config.json';

function fail(field: string, what: string): never {
  throw new Error(`${FILE}: "${field}" ${what}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEnv = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((v) => typeof v === 'string');

function trimmed(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? fail(field, 'must be a non-empty string') : text;
}

// A comparison, not a regex class: Biome's noControlCharactersInRegex refuses one in a pattern (see tasks.ts's BAD_SEGMENT).
// The line is one shell line in a terminal (#300): a C0 control character other than tab could end it early or act on the terminal before
// the shell sees shellQuote's own quotes, so a command or an env value carrying one is refused, not sanitized.
const isControlExceptTab = (c: string): boolean => (c < ' ' && c !== '\t') || c === '\u007f';

function noControlChars(value: string, field: string): string {
  return [...value].some(isControlExceptTab) ? fail(field, 'must not contain control characters') : value;
}

// A name reaches `export NAME=` unquoted, so it is checked here; a value is any string, shellQuoted by ptyCommand. Exported for a workspace's
// own env (#348), which follows the same rules.
export function parseEnv(raw: unknown, field: string): Record<string, string> {
  if (!isEnv(raw)) return fail(field, 'must be an object of strings');
  const bad = Object.keys(raw).find((name) => !ENV_NAME.test(name));
  if (bad !== undefined) fail(`${field}.${bad}`, 'must be a variable name: letters, digits and _, not starting with a digit');
  // #738: a workspace's env now reaches every run, under ptyEnv's names: one of those would be dropped without a word, so it is refused here
  const reserved = Object.keys(raw).find((name) => RESERVED_ENV_NAMES.some((r) => r === name));
  if (reserved !== undefined) fail(`${field}.${reserved}`, 'is set by the Hive and cannot be overridden');
  for (const [name, value] of Object.entries(raw)) noControlChars(value, `${field}.${name}`);
  return { ...raw };
}

/** A timeout key (#511): TIMEOUT's exact text, at most a day; shared by a workspace's setup and a run command. */
export function parseTimeout(raw: unknown, field: string): string {
  return typeof raw === 'string' && TIMEOUT.test(raw) && timeoutMs(raw) !== undefined ? raw : fail(field, 'must be a timeout like "30s", "10m" or "1h", up to 24h');
}

// Is `value` a line's workspace (#755): a name of comb.workspaces, or null for the other workspaces
const isWorkspace = (value: unknown, workspaces: readonly string[]): value is string | null =>
  value === null || (typeof value === 'string' && workspaces.includes(value));

function parseImpl(raw: unknown, field: string, workspaces: readonly string[]): CommandImpl {
  if (!isRecord(raw)) return fail(field, 'must be an object');
  const { workspace, command } = raw;
  if (!isWorkspace(workspace, workspaces)) return fail(`${field}.workspace`, 'must be a workspace of comb.workspaces, or null for the other workspaces');
  return { workspace, command: noControlChars(trimmed(command, `${field}.command`), `${field}.command`) };
}

// A command's lines (#755): at least one, each workspace once, null at most once
function parseImpls(raw: unknown, field: string, workspaces: readonly string[]): CommandImpl[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(field, 'must be a non-empty array of { "workspace", "command" }');
  const impls = raw.map((entry, i) => parseImpl(entry, `${field}[${i}]`, workspaces));
  const twice = impls.findIndex((impl, i) => impls.findIndex((other) => other.workspace === impl.workspace) !== i);
  if (twice !== -1) fail(`${field}[${twice}].workspace`, 'must be unique');
  return impls;
}

// #755: no migration (one user, no backward-compat paths): a file from before names what replaced its keys
const GONE_KEYS = ['command', 'workspaces'] as const;

function parseCommand(raw: unknown, field: string, workspaces: readonly string[]): Command {
  if (!isRecord(raw)) return fail(field, 'must be an object');
  const gone = GONE_KEYS.find((key) => raw[key] !== undefined);
  if (gone !== undefined) fail(`${field}.${gone}`, 'is gone: a command holds "impls" (one { "workspace", "command" } per workspace, null for the other workspaces) and "menu"');
  const { menu } = raw;
  if (typeof menu !== 'boolean') return fail(`${field}.menu`, 'must be true or false');
  return {
    name: noControlChars(trimmed(raw.name, `${field}.name`), `${field}.name`), // #755: a name reaches log lines and console headers
    impls: parseImpls(raw.impls, `${field}.impls`, workspaces),
    menu,
    env: parseEnv(raw.env, `${field}.env`),
    ...(raw.timeout === undefined ? {} : { timeout: parseTimeout(raw.timeout, `${field}.timeout`) }),
  };
}

/** The Comb's commands (#300, #511, #755): required, [] = nothing to run; names unique in the Comb, compared trimmed; each with its lines over
 * `workspaces`. */
export function parseCommands(raw: unknown, field: string, workspaces: readonly string[]): Command[] {
  if (!Array.isArray(raw)) return fail(field, 'must be an array');
  const commands = raw.map((entry, i) => parseCommand(entry, `${field}[${i}]`, workspaces));
  const twice = commands.findIndex((c, i) => commands.findIndex((d) => d.name === c.name) !== i);
  if (twice !== -1) fail(`${field}[${twice}].name`, 'must be unique');
  return commands;
}

/** The line `command` runs in `workspace` (#755): the workspace's own, else the other workspaces' one; undefined = the command does not exist
 * there. The one rule the server and the page both import. */
export const resolveCommand = (command: Pick<Command, 'impls'>, workspace: string): string | undefined =>
  (command.impls.find((i) => i.workspace === workspace) ?? command.impls.find((i) => i.workspace === null))?.command;

/** A command as it runs in one workspace (#755): its line there in place of its lines per workspace, so a launch reads `.command` as before. */
export type ResolvedCommand = Omit<Command, 'impls' | 'menu'> & { command: string };

/** What the task menu and the detail panel offer in `workspace` (#511, #755), in comb.commands order: menu on and a line there. What
 * State.commands lists and POST /run accepts. */
export const commandsIn = (commands: readonly Command[], workspace: string): Command[] =>
  commands.filter((c) => c.menu && resolveCommand(c, workspace) !== undefined);

/** The command `name` as it runs in `workspace` (#511, #755), menu or not; undefined when the Comb lacks it or it has no line there, so a raced
 * click or a stage never runs it elsewhere. */
export function commandIn(commands: readonly Command[], workspace: string, name: string): ResolvedCommand | undefined {
  const found = commands.find((c) => c.name === name);
  const line = found === undefined ? undefined : resolveCommand(found, workspace);
  if (found === undefined || line === undefined) return undefined;
  const { impls: _impls, menu: _menu, ...rest } = found;
  return { ...rest, command: line };
}

const isOnMissing = (value: unknown): value is OnMissing => ON_MISSING.some((m) => m === value);
const COMMANDS_KEYS = ['commands', 'stopOnFailure', 'onMissing'] as const;

/** A commands stage's own keys (#755): the names it runs, in order, non-empty, trimmed and distinct, its switch and what a missing line does,
 * all required with `action: "commands"` and refused without it; model and session mean nothing next to it (no agent runs). A name is not
 * looked up here: one removed from comb.commands must not make the file unloadable, so the stage fails when it runs instead. */
export function parseStageCommands(raw: Record<string, unknown>, field: string): { commands?: string[]; stopOnFailure?: boolean; onMissing?: OnMissing } {
  if (raw.action !== 'commands') {
    for (const key of COMMANDS_KEYS) {
      if (raw[key] !== undefined) fail(`${field}.${key}`, 'needs "action": "commands"');
    }
    return {};
  }
  for (const key of ['model', 'session'] as const) {
    if (raw[key] !== undefined) fail(`${field}.${key}`, 'cannot be combined with "action": "commands"');
  }
  const names = Array.isArray(raw.commands) ? raw.commands.map((name: unknown) => (typeof name === 'string' ? name.trim() : '')) : [];
  if (names.length === 0 || names.includes('') || new Set(names).size !== names.length) fail(`${field}.commands`, 'must be a non-empty array of distinct command names');
  for (const name of names) noControlChars(name, `${field}.commands`);
  const { stopOnFailure, onMissing } = raw;
  if (typeof stopOnFailure !== 'boolean') return fail(`${field}.stopOnFailure`, 'must be true or false');
  if (!isOnMissing(onMissing)) return fail(`${field}.onMissing`, 'must be "fail" or "skip"');
  return { commands: names, stopOnFailure, onMissing };
}

const isCiChecks = (value: unknown): value is CiChecks => CI_CHECKS.some((c) => c === value);
const CI_KEYS = ['ciChecks', 'checks', 'rerunOnce', 'timeout'] as const;

// The list under ciChecks list (#834): names or patterns, trimmed, distinct, non-empty; a check's name reaches log lines and the output
function parseCheckList(raw: unknown, field: string): string[] {
  const names = Array.isArray(raw) ? raw.map((name: unknown) => (typeof name === 'string' ? name.trim() : '')) : [];
  if (names.length === 0 || names.includes('') || new Set(names).size !== names.length) fail(field, 'must be a non-empty array of distinct check names or patterns');
  for (const name of names) noControlChars(name, field);
  return names;
}

/** A wait-for-CI stage's own keys (#834): which checks count, the list under list only, the re-run switch, all required with
 * `action: "waitForCi"`, and the optional wait (absent = no limit); each refused without the action. model and session mean nothing next to
 * it (no agent runs); a commands stage's keys are parseStageCommands' to refuse. */
export function parseStageCi(raw: Record<string, unknown>, field: string): Pick<Stage, 'ciChecks' | 'checks' | 'rerunOnce' | 'timeout'> {
  if (raw.action !== 'waitForCi') {
    for (const key of CI_KEYS) {
      if (raw[key] !== undefined) fail(`${field}.${key}`, 'needs "action": "waitForCi"');
    }
    return {};
  }
  for (const key of ['model', 'session'] as const) {
    if (raw[key] !== undefined) fail(`${field}.${key}`, 'cannot be combined with "action": "waitForCi"');
  }
  const { ciChecks, rerunOnce } = raw;
  if (!isCiChecks(ciChecks)) return fail(`${field}.ciChecks`, 'must be "required", "all" or "list"');
  if (typeof rerunOnce !== 'boolean') return fail(`${field}.rerunOnce`, 'must be true or false');
  const timeout = raw.timeout === undefined ? {} : { timeout: parseTimeout(raw.timeout, `${field}.timeout`) };
  if (ciChecks === 'list') return { ciChecks, checks: parseCheckList(raw.checks, `${field}.checks`), rerunOnce, ...timeout };
  if (raw.checks !== undefined) fail(`${field}.checks`, 'needs "ciChecks": "list"');
  return { ciChecks, rerunOnce, ...timeout };
}
