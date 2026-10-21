// Every load-time migration a hive.config.json may need: #511 (each workspace's run commands and its setup timeout in minutes), #513 (the
// menuBar / stopOnClose pair), #515 (a stage's single onStart / onFinish action per source), #516 (the default agent), #924 (claudeArgs into agentArgs), #927 (agentArgs.codex), #754 (the files tree's icons), #846 (where new tasks are created), #134 (comb.transitions from the stage list) and #727 (retired keys). readConfig reads a file through here, in memory only: the next save writes today's shape. Pure and
// idempotent; malformed entries pass through untouched, so parseConfig still names their fault.

import { hasFixedVerdicts } from './stage-agent.js';
import { END, FILE_ICONS_DEFAULTS, type SourceAction, type Stage, type Transition } from './types.js';

type Entry = Record<string, unknown>;

const isRecord = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value);
/** What an absent setupTimeoutMinutes meant before #511, for a workspace that had a setup. */
const LEGACY_SETUP_TIMEOUT = '5m';

// setupTimeoutMinutes becomes setupTimeout; a non-number is carried as is, for the parser to refuse by name.
function migratedWorkspace(workspace: unknown): unknown {
  if (!isRecord(workspace)) return workspace;
  const { commands: _commands, setupTimeoutMinutes: minutes, ...rest } = workspace;
  if (minutes !== undefined) return { ...rest, setupTimeout: typeof minutes === 'number' ? `${minutes}m` : minutes };
  return rest.setup === undefined || rest.setupTimeout !== undefined ? rest : { ...rest, setupTimeout: LEGACY_SETUP_TIMEOUT };
}

const sameRun = (a: Entry, b: Entry): boolean => a.command === b.command && JSON.stringify(a.env) === JSON.stringify(b.env);

// One workspace command into the list so far: a same-named identical one gains the workspace, a different one is renamed after its workspace.
// A malformed entry is kept (a record with its workspace), so the parser names its fault.
function gather(list: unknown[], command: unknown, workspace: string): unknown[] {
  if (!isRecord(command)) return [...list, command];
  if (typeof command.name !== 'string' || typeof command.command !== 'string') return [...list, { ...command, workspaces: [workspace] }];
  const twin = list.find((c): c is Entry => isRecord(c) && c.name === command.name);
  if (twin === undefined) return [...list, { ...command, workspaces: [workspace] }];
  if (!sameRun(twin, command)) return [...list, { ...command, name: `${command.name} (${workspace})`, workspaces: [workspace] }];
  return list.map((c) => (c === twin ? { ...twin, workspaces: [...(twin.workspaces as string[]), workspace] } : c));
}

// Every workspace's commands, in workspace order then command order.
const gathered = (workspaces: unknown[]): unknown[] =>
  workspaces.reduce<unknown[]>((list, p) => {
    if (!isRecord(p) || !Array.isArray(p.commands)) return list;
    return (p.commands as unknown[]).reduce<unknown[]>((acc, c) => gather(acc, c, String(p.name)), list);
  }, []);

/** A pre-#511 file (a workspace with a `commands` key) in today's shape; anything else comes back as the same reference. */
export function migrateWorkspaces(raw: unknown): unknown {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const workspaces = isRecord(comb) ? comb.workspaces : undefined;
  if (!isRecord(raw) || !isRecord(comb) || !Array.isArray(workspaces)) return raw;
  if (!workspaces.some((p) => isRecord(p) && p.commands !== undefined)) return raw;
  const commands = comb.commands === undefined ? { commands: gathered(workspaces) } : {};
  return { ...raw, comb: { ...comb, workspaces: workspaces.map(migratedWorkspace), ...commands } };
}

/** A pre-#513 file's two viewer switches as onClose. Only menu bar off with stop on close quit; every other mix, a garbage value
 * included, kept the workers running, so it is menuBar. A present onClose wins; the old keys always go. */
export function migrateOnClose(raw: unknown): unknown {
  if (!isRecord(raw) || (raw.menuBar === undefined && raw.stopOnClose === undefined)) return raw;
  const { menuBar, stopOnClose, ...rest } = raw;
  if (rest.onClose !== undefined) return rest;
  return { ...rest, onClose: menuBar === false && stopOnClose === true ? 'quit' : 'menuBar' };
}

// #515: onStart / onFinish went from one action per source to a list per source. A single action object becomes a one-element list;
// a list, and anything malformed (a pre-#286 string, null), passes through for the parser to name. Lossless: every action is kept.
const listed = (map: unknown): unknown =>
  isRecord(map) ? Object.fromEntries(Object.entries(map).map(([source, v]) => [source, isRecord(v) ? [v] : v])) : map;

const needsList = (map: unknown): boolean => isRecord(map) && Object.values(map).some(isRecord);

function migratedStage(stage: unknown): unknown {
  if (!isRecord(stage) || (!needsList(stage.onStart) && !needsList(stage.onFinish))) return stage;
  return { ...stage, ...(stage.onStart === undefined ? {} : { onStart: listed(stage.onStart) }), ...(stage.onFinish === undefined ? {} : { onFinish: listed(stage.onFinish) }) };
}

/** A pre-#515 file's single stage actions as lists; anything else comes back as the same reference. */
export function migrateStageActions(raw: unknown): unknown {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const stages = isRecord(comb) ? comb.stages : undefined;
  if (!isRecord(raw) || !isRecord(comb) || !Array.isArray(stages)) return raw;
  if (!stages.some((s) => isRecord(s) && (needsList(s.onStart) || needsList(s.onFinish)))) return raw;
  return { ...raw, comb: { ...comb, stages: stages.map(migratedStage) } };
}

/** The one agent there was before #516: what a file without defaultAgent ran. Frozen, so a later DEFAULT_AGENT change does not rewrite old files. */
const LEGACY_AGENT = 'claude';

/** A pre-#516 file gains defaultAgent: claude; anything else comes back as the same reference. Stages keep no agent: absent = the default. */
export const migrateDefaultAgent = (raw: unknown): unknown => (isRecord(raw) && raw.defaultAgent === undefined ? { ...raw, defaultAgent: LEGACY_AGENT } : raw);

/** A pre-#924 file's claudeArgs becomes agentArgs.claude; a file with neither gets an empty list; claudeArgs goes either way. Today's shape
 * comes back as the same reference; a malformed value passes through for the parser to name. */
export function migrateAgentArgs(raw: unknown): unknown {
  if (!isRecord(raw) || (raw.agentArgs !== undefined && !Object.hasOwn(raw, 'claudeArgs'))) return raw;
  const { claudeArgs, ...rest } = raw;
  return rest.agentArgs !== undefined ? rest : { ...rest, agentArgs: { [LEGACY_AGENT]: claudeArgs ?? [] } };
}

/** A pre-#927 file's agentArgs gains codex: [] (parseAgentArgs requires every agent). One that has it, or with no agentArgs record (the parser
 * names that), comes back as the same reference. */
export const migrateCodexArgs = (raw: unknown): unknown =>
  (isRecord(raw) && isRecord(raw.agentArgs) && raw.agentArgs.codex === undefined ? { ...raw, agentArgs: { ...raw.agentArgs, codex: [] } } : raw);

/** A pre-#754 file gains fileIcons with the form's defaults; a present key, a wrong one included, comes back as the same reference for the parser. */
export const migrateFileIcons = (raw: unknown): unknown => (isRecord(raw) && raw.fileIcons === undefined ? { ...raw, fileIcons: FILE_ICONS_DEFAULTS } : raw);

/** A stage as a file from before #134 writes it (#134): today's keys and the two the migration drops. */
export type LegacyStage = Stage & { onFinish?: Record<string, SourceAction[]>; visible?: number };

const runsCommands = (s: LegacyStage): boolean => hasFixedVerdicts(s); // #877: an evaluate stage too, as test fixtures chain it

// The trigger a stage end fired before #134: an approval, a passed check, or the end of whatever else ran
const triggerOf = (s: LegacyStage): Pick<Transition, 'when' | 'verdict'> =>
  (s.approval === true ? { when: 'approved' } : runsCommands(s) ? { when: 'verdict', verdict: 'passed' } : { when: 'done' });

const finishOf = (s: LegacyStage): Pick<Transition, 'sources'> => (s.onFinish === undefined || Object.keys(s.onFinish).length === 0 ? {} : { sources: s.onFinish });

// A gate's feedback resumed the reviewed stage's session (#685): the nearest earlier stage that runs a prompt
function feedbackOf(s: LegacyStage, i: number, stages: readonly LegacyStage[]): Transition[] {
  if (s.approval !== true) return [];
  if (s.prompt !== undefined) return [{ from: s.name, to: s.name, when: 'feedback', session: 'previous' }];
  const reviewed = stages.slice(0, i).reverse().find((p) => p.prompt !== undefined && p.action === undefined);
  return reviewed === undefined ? [] : [{ from: s.name, to: reviewed.name, when: 'feedback', session: { continueOf: reviewed.name } }];
}

/** A pre-#134 stage list as transitions (#134): each pair of consecutive stages by the trigger its first one fired, the last one to end, each
 * with its stage's onFinish; then a feedback transition per stage with approval. */
export function transitionsOf(stages: readonly LegacyStage[]): Transition[] {
  const forward = stages.map((s, i): Transition => ({ from: s.name, to: stages[i + 1]?.name ?? END, ...triggerOf(s), ...finishOf(s) }));
  return [...forward, ...stages.flatMap((s, i) => feedbackOf(s, i, stages))];
}

/** A stage without what #134 retired: onFinish moved to the transitions, visible (the page no longer pages). */
export const stripLegacy = ({ onFinish: _onFinish, visible: _visible, ...stage }: LegacyStage): Stage => stage;

const isLegacyStage = (stage: unknown): stage is LegacyStage => isRecord(stage) && typeof stage.name === 'string';

/** A pre-#134 comb (no transitions) gets them from its stages, in memory; onFinish and visible leave every stage, whether or not the comb had transitions.
 * A comb already in today's shape, or with a stage the parser must name, comes back as the same reference. */
export function migrateTransitions(raw: unknown): unknown {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const stages = isRecord(comb) ? comb.stages : undefined;
  if (!isRecord(raw) || !isRecord(comb) || !Array.isArray(stages) || !stages.every(isLegacyStage)) return raw;
  const stale = stages.some((s) => s.onFinish !== undefined || s.visible !== undefined);
  if (comb.transitions !== undefined && !stale) return raw;
  return { ...raw, comb: { ...comb, stages: stages.map(stripLegacy), ...(comb.transitions === undefined ? { transitions: transitionsOf(stages) } : {}) } };
}

/** #727: retired keys. maxConcurrent lives in the state now; shortcuts.toggleAuto named the Hive's auto's key, which is gone, and parseShortcuts
 * refuses an unknown id. A file with neither comes back as the same reference. */
export function migrateRetiredKeys(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const retiredKey = isRecord(raw.shortcuts) && Object.hasOwn(raw.shortcuts, 'toggleAuto');
  if (!Object.hasOwn(raw, 'maxConcurrent') && !retiredKey) return raw;
  const { maxConcurrent: _max, ...rest } = raw;
  if (!retiredKey || !isRecord(raw.shortcuts)) return rest;
  const { toggleAuto: _toggleAuto, ...shortcuts } = raw.shortcuts;
  return { ...rest, shortcuts };
}

/** What a file from before #846 did: every task born in hive, which was always on. Frozen, like LEGACY_AGENT. */
const LEGACY_CREATE_IN = 'hive';

/** A pre-#846 file's Comb gains hiveSource: true and createIn: hive, whichever it lacks; a present key, a wrong one included, is kept for the
 * parser; a file with both comes back as the same reference. */
export function migrateCreateIn(raw: unknown): unknown {
  const comb = isRecord(raw) ? raw.comb : undefined;
  if (!isRecord(raw) || !isRecord(comb) || (comb.hiveSource !== undefined && comb.createIn !== undefined)) return raw;
  return { ...raw, comb: { hiveSource: true, createIn: LEGACY_CREATE_IN, ...comb } };
}

/** Every load-time migration, oldest first: readConfig's one entry point. */
export const migrateConfig = (raw: unknown): unknown => migrateCreateIn(migrateRetiredKeys(migrateTransitions(migrateFileIcons(migrateCodexArgs(migrateAgentArgs(migrateDefaultAgent(migrateStageActions(migrateOnClose(migrateWorkspaces(raw))))))))));
