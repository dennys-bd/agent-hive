import { realpath } from 'node:fs/promises';
import { activityOfWorker, taskOfWorker } from './activities.js';
import { migrateTransitions } from './config-migrate.js';
import { taskWorkspace, loadConfigIfPresent, parseConfig } from './config.js';
import type { Refusal } from './server-tasks.js';
import { parseSetup } from './setup-script.js';
import type { Config, Language, Workspace, SettingsBody, State } from './types.js';
import { workspacePathProblem } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

const isNameMap = (raw: unknown): raw is Record<string, string> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.values(raw).every((v) => typeof v === 'string');

// #846: a source rename carries createIn, as the form carries the stages' from by row id; a body that names createIn wins
const renamedCreateIn = (createIn: string | undefined, renames: unknown): string | undefined =>
  (createIn !== undefined && isNameMap(renames) && Object.hasOwn(renames, createIn) ? renames[createIn] : createIn);

/** The body over the saved file: a key the body omits keeps the saved value (the form always sends the ones it owns). A file that does
 * not parse (one from before the Comb, or from before workspace names) is no current config: the body is all there is. */
export async function configFrom(home: string, body: Partial<SettingsBody>): Promise<Config> {
  const current = await loadConfigIfPresent(home).catch(() => undefined);
  // #134: a body that sends stages without transitions (an API caller) gets them from those stages, as a file from before #134 does; one that
  // sends neither keeps the saved ones
  const transitions = body.transitions ?? (body.stages === undefined ? current?.comb.transitions : undefined);
  return parseConfig(migrateTransitions({
    comb: {
      prefix: body.prefix,
      workspaces: body.workspaces ?? current?.comb.workspaces, // the form's workspaces list (#179)
      sources: body.sources ?? current?.comb.sources, // the form's sources list (#180); [] = no source
      stages: body.stages ?? current?.comb.stages,
      transitions,
      commands: body.commands ?? current?.comb.commands, // the form always sends it (#511), [] included
      hiveSource: body.hiveSource ?? current?.comb.hiveSource, // #846
      createIn: body.createIn ?? renamedCreateIn(current?.comb.createIn, body.renames),
    },
    auth: body.auth ?? current?.auth, // the form sends it with a GitHub source; an API caller that omits it keeps the saved transport
    claudeArgs: current?.claudeArgs,
    branch: body.branch ?? current?.branch, // the form always sends it (empty field = key absent); an API caller that omits it keeps the current template
    logLevel: current?.logLevel, // never in the body: the file is the switch
    budget: body.budget ?? current?.budget,
    usageRules: body.usageRules ?? current?.usageRules,
    language: body.language ?? current?.language, // the form always sends it; an API caller that omits it keeps the saved one
    theme: body.theme ?? current?.theme, // the form always sends it (#296); an API caller that omits it keeps the saved one
    terminalFont: body.terminalFont ?? current?.terminalFont, // the form always sends it (#376), "" included; an API caller that omits it keeps the saved one
    trustedDomains: body.trustedDomains ?? current?.trustedDomains, // the form always sends it (#404), [] included; POST /trusted-domains sends the list plus its host
    shortcuts: body.shortcuts ?? current?.shortcuts, // the form always sends it (#449), {} included; POST /trusted-domains sends none and keeps the saved map
    consoleLines: body.consoleLines ?? current?.consoleLines, // the form always sends it (#353); an API caller that omits it keeps the saved value
    baseBranch: body.baseBranch ?? current?.baseBranch, // the form always sends it ('' = automatic); an omitted key keeps the saved one
    onClose: body.onClose ?? current?.onClose, // the form always sends it (#513); an API caller that omits it keeps the saved value
    notifications: body.notifications ?? current?.notifications, // the form always sends it (#199); an API caller that omits it keeps the saved value
    deleteActivity: body.deleteActivity ?? current?.deleteActivity, // the form always sends it (#236, #573); an API caller that omits it keeps the saved scope
    shutdownIdleMinutes: body.shutdownIdleMinutes ?? current?.shutdownIdleMinutes, // the form always sends it (#233); an API caller that omits it keeps the saved value
    approvalMinutes: body.approvalMinutes ?? current?.approvalMinutes, // the form always sends it (#268); an API caller that omits it keeps the saved value
    rateLimitWaitMinutes: body.rateLimitWaitMinutes ?? current?.rateLimitWaitMinutes, // the form always sends it (#805); an API caller that omits it keeps the saved value
    showGithubQuota: body.showGithubQuota ?? current?.showGithubQuota, // the form always sends it; an API caller that omits it keeps the saved value
    closeSessionTab: body.closeSessionTab ?? current?.closeSessionTab, // the form always sends it (#614); an API caller that omits it keeps the saved value
    closeStageTab: body.closeStageTab ?? current?.closeStageTab, // same rules (#614)
    closeSessionTabNotice: body.closeSessionTabNotice ?? current?.closeSessionTabNotice, // same rules; the notice's checkbox sends it alone (#614)
    closeStageTabNotice: body.closeStageTabNotice ?? current?.closeStageTabNotice, // same rules (#614)
    sleepNotice: body.sleepNotice ?? current?.sleepNotice, // the form always sends it (#672); a notice's checkbox sends it alone
    sleepAutoNotice: body.sleepAutoNotice ?? current?.sleepAutoNotice, // same rules (#672)
    sleepIdleNotice: body.sleepIdleNotice ?? current?.sleepIdleNotice, // same rules (#672)
    sleepAllNotice: body.sleepAllNotice ?? current?.sleepAllNotice, // same rules (#672)
    closeTerminalTab: body.closeTerminalTab ?? current?.closeTerminalTab, // the form always sends it (#696)
    closeTerminalTabNotice: body.closeTerminalTabNotice ?? current?.closeTerminalTabNotice, // same rules; the keep notice's checkbox sends it alone (#696)
    defaultAgent: body.defaultAgent ?? current?.defaultAgent, // the form always sends it (#516); an API caller that omits it keeps the saved one
    fileIcons: body.fileIcons ?? current?.fileIcons, // the form always sends it (#754); an API caller that omits it keeps the saved one
    sidebarsPerView: body.sidebarsPerView ?? current?.sidebarsPerView, // the form always sends it (#821); an API caller that omits it keeps the saved one
    signals: body.signals ?? current?.signals, // the form always sends it (#727); an API caller that omits it keeps the saved one
    editor: body.editor ?? current?.editor, // the form always sends it (#780); an API caller that omits it keeps the saved one
  }));
}

// The names of the workspaces an occupied worker's task resolves to: a stage run, or a free session, is inside one of their worktrees.
// A local session's worker (#587) names its workspace itself: it runs in that checkout.
function busyWorkspaces(config: Config, state: State): Set<string> {
  return new Set(state.workers.flatMap((s) => {
    if (s.status === 'empty') return [];
    const local = activityOfWorker(state, s);
    if (local?.kind === 'local') return [local.workspace];
    const task = taskOfWorker(state, s);
    const workspace = task && taskWorkspace(config, task);
    return workspace ? [workspace.name] : [];
  }));
}

// Two workspaces that resolve to the same folder (a trailing slash, a symlink and its target): the pair, name first, first found wins.
// Run only once every path is a confirmed git top level, so realpath never sees a bad one.
async function sameFolderPair(workspaces: Workspace[]): Promise<[Workspace, Workspace] | undefined> {
  const real = await Promise.all(workspaces.map((p) => realpath(p.path)));
  for (let i = 0; i < workspaces.length; i += 1) {
    for (let j = i + 1; j < workspaces.length; j += 1) {
      if (real[i] === real[j]) return [workspaces[i], workspaces[j]];
    }
  }
  return undefined;
}

/** Why a save cannot take `next`'s workspaces (#179, #202): every folder must be a repo's top level (400), two workspaces may not resolve to
 * the same folder (400: a live task's worktree in one would show as an orphan, removable, under the other), and a workspace a running task
 * resolves to cannot be removed or re-pathed (409): its worker stays in the old repo. Any other workspace may come and go. */
export async function workspacesRefusal(next: Config, live?: { config: Config; state: State }): Promise<Refusal | undefined> {
  for (const { path } of next.comb.workspaces) {
    const problem = await workspacePathProblem(path);
    if (problem) return { status: HTTP_BAD_REQUEST, message: problem };
  }
  const same = await sameFolderPair(next.comb.workspaces);
  if (same) return { status: HTTP_BAD_REQUEST, message: `workspaces ${same[0].name} and ${same[1].name} point at the same folder` };
  if (!live) return undefined;
  const busy = busyWorkspaces(live.config, live.state);
  const kept = (p: Workspace): boolean => next.comb.workspaces.some((q) => q.name === p.name && q.path === p.path);
  const lost = live.config.comb.workspaces.find((p) => busy.has(p.name) && !kept(p));
  return lost ? { status: HTTP_CONFLICT, message: `workspace ${lost.name} has a running worker` } : undefined;
}

// Each script with the prefix its 400 carries: the setup's text is unchanged since #299, the teardown's names itself (#654)
const SCRIPTS = [['setup', ''], ['teardown', 'teardown ']] as const;

/** Why a save cannot take a workspace's worktree scripts (#299, #654): the first line parseSetup refuses, named after its workspace and, for
 * the teardown, the script (400). A LOAD file is read only when the script runs, so its own lines are checked then. */
export function setupRefusal(next: Config): Refusal | undefined {
  for (const workspace of next.comb.workspaces) {
    for (const [key, prefix] of SCRIPTS) {
      try {
        parseSetup(workspace[key] ?? '', { allowLoad: true });
      } catch (err) {
        return { status: HTTP_BAD_REQUEST, message: `${workspace.name}: ${prefix}${(err as Error).message}` };
      }
    }
  }
  return undefined;
}

const RENAMES_SHAPE = 'renames must map source names to source names';

const hasSource = (config: Config, name: string): boolean => config.comb.sources.some((b) => b.name === name);

// The map itself (#278), first problem wins: each key a source of the running Hive that leaves the saved config or is itself a new name
// (a swap, a chain), each value a source of the saved config, no two keys onto one value. The form never sends a bad one.
function renamesProblem(renames: Record<string, string>, next: Config, live: Config): string | undefined {
  const entries = Object.entries(renames);
  const targets = entries.map(([, to]) => to);
  const unknown = entries.find(([from]) => !hasSource(live, from));
  if (unknown) return `renames: ${unknown[0]} is not a source of the running Hive`;
  const kept = entries.find(([from]) => hasSource(next, from) && !targets.includes(from));
  if (kept) return `renames: ${kept[0]} is still a source of this config`;
  const stray = entries.find(([, to]) => !hasSource(next, to));
  if (stray) return `renames: ${stray[1]} is not a source of this config`;
  const at = targets.findIndex((to, i) => targets.indexOf(to) !== i);
  if (at < 0) return undefined;
  const [from, to] = entries[at];
  return `renames: ${entries[targets.indexOf(to)][0]} and ${from} both rename to ${to}`;
}

/** Why a save cannot apply `renames` (#278): a map that is not source names or one the running Hive cannot apply (400), or a new name that a
 * task the rename does not rewrite still carries, a removed source's (409): the renamed source would inherit it. Nothing to carry without a
 * live Hive, and an omitted map renames nothing. */
export function renamesRefusal(renames: unknown, next: Config, live?: { config: Config; state: State }): Refusal | undefined {
  if (!live || renames === undefined) return undefined;
  if (!isNameMap(renames)) return { status: HTTP_BAD_REQUEST, message: RENAMES_SHAPE };
  const problem = renamesProblem(renames, next, live.config);
  if (problem) return { status: HTTP_BAD_REQUEST, message: problem };
  const taken = Object.values(renames).find((to) => !Object.hasOwn(renames, to) && live.state.tasks.some((c) => c.item.source === to));
  if (taken === undefined) return undefined;
  const count = live.state.tasks.filter((c) => c.item.source === taken).length;
  return { status: HTTP_CONFLICT, message: `source ${taken} is still used by ${count} tasks of a removed source: close them first` };
}

// #846: the one refusal the form cannot make itself; only the server holds the state
const HIVE_BUSY: Record<Language, (n: number) => string> = {
  en: (n) => `${n} tasks are still in hive; close them before turning it off`,
  pt: (n) => `${n} tarefas ainda estão no hive; feche-as antes de desligá-lo`,
};

/** Why a save cannot turn hive off (#846): the live state still holds a task created in the Hive (409, in the save's language). A first setup
 * has no task. */
export function hiveSourceRefusal(next: Config, state: State | undefined, language: Language): Refusal | undefined {
  if (next.comb.hiveSource || state === undefined) return undefined;
  const n = state.tasks.filter((c) => c.created).length;
  return n === 0 ? undefined : { status: HTTP_CONFLICT, message: HIVE_BUSY[language](n) };
}
