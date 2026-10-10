import { timeoutMs } from '../../timeout.js';
import { ENV_NAME, RESERVED_ENV_NAMES, type Command } from '../../types.js';
import { t } from '../i18n.js';
import type { WorkspaceDraft, SettingsDraft, SettingsProblem } from './settings-form.js';

// Settings › workspaces' env editors and command table (#300, #348, #511, #755), out of settings-form.ts, which is over 400 lines.

/** A row of an env editor (#348): a workspace's own or a command's; id is its React key, never sent. */
export interface EnvRowDraft { id: string; name: string; value: string }
/** One line of a command row (#755): workspace = a workspace row's id, so a rename in the form carries it, or null for every workspace with no
 * line of its own; id is its React key, never sent. */
export interface ImplDraft { id: string; workspace: string | null; command: string }
/** A row of the Comb's command table (#300, #511, #755): its lines per workspace, whether the task menu offers it, its env as rows (#348); id is
 * its React key, never sent. */
export interface CommandDraft { id: string; name: string; impls: ImplDraft[]; menu: boolean; env: EnvRowDraft[]; timeout: string }
/** A workspace that sets a name a command's own variable replaces (#511), for the note beside the row. */
export interface Override { workspace: string; value: string }

export const emptyEnvRow = (): EnvRowDraft => ({ id: crypto.randomUUID(), name: '', value: '' });
export const envRows = (env: Record<string, string>): EnvRowDraft[] => Object.entries(env).map(([name, value]) => ({ ...emptyEnvRow(), name, value }));

// An env editor's rows as the config's object (#348): a row left with no name and no value is a + never used, dropped; the name is trimmed,
// the value kept as typed, edge spaces included. validateSettings ran first.
const filledRows = (rows: EnvRowDraft[]): EnvRowDraft[] => rows.filter((r) => r.name.trim() !== '' || r.value !== '');
export const envFrom = (rows: EnvRowDraft[]): Record<string, string> => Object.fromEntries(filledRows(rows).map((r) => [r.name.trim(), r.value]));

// An env editor's kept rows each have a name `export` takes, none used twice (#348), and none the Hive sets itself (#738: the parser refuses
// those too); a value with a blank name fails ENV_NAME too. The value is anything.
const isEnvValid = (rows: EnvRowDraft[]): boolean => {
  const names = filledRows(rows).map((r) => r.name.trim());
  return names.every((name, i) => ENV_NAME.test(name) && !RESERVED_ENV_NAMES.some((r) => r === name) && names.indexOf(name) === i);
};

export const emptyImpl = (workspace: string | null): ImplDraft => ({ id: crypto.randomUUID(), workspace, command: '' });

/** A new command (#755): one line for all workspaces, offered in the task menu. */
export const emptyCommand = (): CommandDraft => ({ id: crypto.randomUUID(), name: '', impls: [emptyImpl(null)], menu: true, env: [], timeout: '' });

const rowOf = (workspaces: readonly WorkspaceDraft[], id: string | null): WorkspaceDraft | undefined => workspaces.find((p) => p.id === id);

/** A command's lines as the editor stacks them and the save sends them (#755): each current workspace row's own, by its name, then the line of
 * the other workspaces; a line of a removed row is left out. */
export function stackedImpls(c: Pick<CommandDraft, 'impls'>, workspaces: readonly WorkspaceDraft[]): ImplDraft[] {
  const nameOf = (i: ImplDraft): string => rowOf(workspaces, i.workspace)?.name.trim() ?? '';
  const own = c.impls.filter((i) => rowOf(workspaces, i.workspace) !== undefined).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return [...own, ...c.impls.filter((i) => i.workspace === null)];
}

/** The workspace rows a command has no line of its own in (#755), in row order: what + workspace and each line's select offer. */
export const freeWorkspaces = (c: Pick<CommandDraft, 'impls'>, workspaces: readonly WorkspaceDraft[]): WorkspaceDraft[] =>
  workspaces.filter((p) => !c.impls.some((i) => i.workspace === p.id));

/** Where a command does not exist (#755): the workspaces with no line of their own, none when a line covers the other workspaces. */
export const missingWorkspaces = (c: Pick<CommandDraft, 'impls'>, workspaces: readonly WorkspaceDraft[]): WorkspaceDraft[] =>
  (c.impls.some((i) => i.workspace === null) ? [] : freeWorkspaces(c, workspaces));

/** A saved command over the workspace rows (#755): each line's workspace name becomes the first row with that trimmed name; an unknown one is
 * dropped. */
export const commandDraft = (c: Command, workspaces: WorkspaceDraft[]): CommandDraft => ({
  ...emptyCommand(), name: c.name, menu: c.menu, env: envRows(c.env), timeout: c.timeout ?? '',
  impls: c.impls.flatMap((impl) => {
    const workspace = impl.workspace === null ? null : workspaces.find((p) => p.name.trim() === impl.workspace)?.id;
    return workspace === undefined ? [] : [{ ...emptyImpl(workspace), command: impl.command }];
  }),
});

/** A command row as a comb.commands entry (#755): its lines in stackedImpls' order, each workspace by its name, the lines trimmed; an empty
 * timeout sends no key. */
export function commandFrom(c: CommandDraft, workspaces: WorkspaceDraft[]): Command {
  const timeout = c.timeout.trim();
  const impls = stackedImpls(c, workspaces).map((i) => ({ workspace: rowOf(workspaces, i.workspace)?.name.trim() ?? null, command: i.command.trim() }));
  return { name: c.name.trim(), impls, menu: c.menu, env: envFrom(c.env), ...(timeout === '' ? {} : { timeout }) };
}

// The first command problem's text (#300, #511, #755): named, names unique in the Comb, a line in some workspace, every line filled, a timeout
// text, env rows a shell can export.
function commandProblem(commands: CommandDraft[], workspaces: WorkspaceDraft[]): string | undefined {
  const nameless = commands.findIndex((c) => c.name.trim() === '');
  if (nameless !== -1) return t('settings.error.commandName', { n: nameless + 1 });
  const names = commands.map((c) => c.name.trim());
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) return t('settings.error.commandDuplicate', { name: twice });
  const implless = commands.find((c) => stackedImpls(c, workspaces).length === 0);
  if (implless !== undefined) return t('settings.error.commandImpls', { name: implless.name.trim() });
  const lineless = commands.findIndex((c) => stackedImpls(c, workspaces).some((i) => i.command.trim() === ''));
  if (lineless !== -1) return t('settings.error.command', { n: lineless + 1 });
  const slow = commands.findIndex((c) => c.timeout.trim() !== '' && timeoutMs(c.timeout) === undefined);
  if (slow !== -1) return t('settings.error.commandTimeout', { n: slow + 1 });
  const badEnv = commands.findIndex((c) => !isEnvValid(c.env));
  return badEnv === -1 ? undefined : t('settings.error.commandEnv', { n: badEnv + 1 });
}

/** Settings › workspaces' env and commands (#348, #511): each workspace's env first, then the command table; the first problem. */
export function commandsProblem(draft: Pick<SettingsDraft, 'workspaces' | 'commands'>): SettingsProblem | undefined {
  const badEnv = draft.workspaces.find((p) => !isEnvValid(p.env));
  const message = badEnv ? t('settings.error.workspaceEnv', { workspace: badEnv.name.trim() }) : commandProblem(draft.commands, draft.workspaces);
  return message === undefined ? undefined : { section: 'workspaces', message };
}

/** The workspaces the command runs in that set `name` too (#511, #755), in row order: what the command's own value replaces there. */
export function overrides(command: CommandDraft, workspaces: WorkspaceDraft[], name: string): Override[] {
  if (name === '') return [];
  const missing = missingWorkspaces(command, workspaces);
  return workspaces.filter((p) => !missing.includes(p)).flatMap((p) => {
    const row = filledRows(p.env).find((r) => r.name.trim() === name);
    return row ? [{ workspace: p.name.trim(), value: row.value }] : [];
  });
}
