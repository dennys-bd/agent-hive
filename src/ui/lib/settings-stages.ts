import { destinationOf } from '../../stage-delete.js';
import type { HiveAction } from '../../stage-agent.js';
import { isGate, onSource } from '../../tasks.js';
import { type AgentId, type CiChecks, SOURCE_ACTIONS, type SourceAction, type SourceFields, isLeaving, type ItemAction, LEAVING_ACTIONS, type OnMissing, type Stage, type StageAction, type Task } from '../../types.js';
import { t, tPlural } from '../i18n.js';

// Settings › fluxo's stage editor (#515): the draft ↔ Stage edges and the action-list rules the entra / executa / sai blocks offer, out of
// settings-form.ts, as settings-rules.ts and settings-commands.ts are.

// commands / stopOnFailure / onMissing (#755): a commands stage's names in run order, its switch and what a missing line does; ciChecks / checks /
// rerunOnce / timeout (#834): a wait for CI's which checks, its list, its switch and its wait ('' = no limit). Each kept as typed while another
// action is picked, sent only with its own action.
// savedName (#861): the name the stage was loaded with, absent on a new one: what a rename is read from; never sent
// id: a per-stage React key, never sent. from / onStart are keyed by source row id (#180): a name the user is still typing never
// splits an entry. onStart holds an ordered list per row (#515).
// gate (#134): the draft's só aprovação, a stage that runs nothing and awaits approval; verdicts: a prompt stage's own, in order
// skill (#710): a skill stage's bare skill name, '' = none picked yet; specializedAgent: hive:<name>, '' = none
export interface StageDraft { id: string; name: string; session: 'new' | 'continue'; model: string; agent: '' | AgentId; from: Record<string, string[]>; onStart: Record<string, SourceAction[]>; gate: boolean; verdicts: string[]; prompt: string; skill: string; specializedAgent: string; action: '' | StageAction; after: string; approval: boolean; handoff: boolean; maxWorkers: string; commands: string[]; stopOnFailure: boolean; onMissing: OnMissing; ciChecks: CiChecks; checks: string[]; rerunOnce: boolean; timeout: string; savedName?: string }
/** What a stage's maps are keyed against: a source row's id and its name as typed. */
export interface StageRow { id: string; name: string }

const META_WORD_MAX = 24;

export const emptyStage = (): StageDraft => ({ id: crypto.randomUUID(), name: '', session: 'new', model: '', agent: '', from: {}, onStart: {}, gate: false, verdicts: [], prompt: '', skill: '', specializedAgent: '', action: '', after: '', approval: false, handoff: false, maxWorkers: '', commands: [], stopOnFailure: true, onMissing: 'fail', ciChecks: 'required', checks: [], rerunOnce: false, timeout: '60m' });

/** A number field's text: 0 or absent = no limit = empty. */
export const numberField = (n?: number): string => (n ? String(n) : '');
const isNonNegativeInt = (text: string): boolean => /^\d+$/.test(text.trim());
/** A limit field as a number: empty or 0 = no limit = undefined. */
export const limitFrom = (text: string): number | undefined => (isNonNegativeInt(text) && Number(text) > 0 ? Number(text) : undefined);
/** A trimmed text under `key`, or no key at all when it is blank: hive.config.json never holds an empty optional. */
export const optional = <K extends string>(key: K, value: string): { [P in K]?: string } => (value.trim() === '' ? {} : { [key]: value.trim() }) as { [P in K]?: string };

// A saved map keyed by source name, keyed by row id for the draft (#180); an entry naming no row is dropped.
export const byRow = <T>(map: Record<string, T> | undefined, rows: readonly StageRow[]): Record<string, T> =>
  Object.fromEntries(rows.flatMap((r) => { const value = onSource(map, r.name); return value === undefined ? [] : [[r.id, value]]; }));

/** One source row's entry of a draft map set to `value`, or dropped when it is undefined; a new map either way. */
export const withEntry = <T>(map: Record<string, T>, key: string, value: T | undefined): Record<string, T> => {
  const { [key]: _dropped, ...rest } = map;
  return value === undefined ? rest : { ...rest, [key]: value };
};

export const stageDraft = (c: Stage, rows: StageRow[]): StageDraft => ({
  id: crypto.randomUUID(), name: c.name, savedName: c.name, session: c.session ?? 'new', model: c.model ?? '', agent: c.agent ?? '', // '' = the default agent (#516)
  from: byRow(c.from, rows), onStart: byRow(c.onStart, rows), gate: isGate(c), verdicts: c.verdicts ?? [], prompt: c.prompt ?? '', skill: c.skill ?? '', specializedAgent: c.specializedAgent ?? '', // #710
  action: c.action ?? '', after: c.after ?? '', approval: c.approval === true, handoff: c.handoff === true, // #692
  maxWorkers: c.maxWorkers === undefined ? '' : String(c.maxWorkers), // #475: not numberField, which reads 0 as empty; 0 here is a cap
  commands: c.commands ?? [], stopOnFailure: c.stopOnFailure ?? true, onMissing: c.onMissing ?? 'fail', // #755: the form starts the switch on and onMissing on fail; the file has no default
  ciChecks: c.ciChecks ?? 'required', checks: c.checks ?? [], rerunOnce: c.rerunOnce ?? false, // #834: the form starts on required with the switch off
  timeout: c.action === 'waitForCi' ? c.timeout ?? '' : '60m', // #834: a saved wait with no key has no limit; a stage turned into one starts on 60m
});

// #755, #834: each action sends its own keys only; parseStage refuses the others
function actionKeys(c: StageDraft, action: HiveAction): Partial<Stage> {
  if (action === 'commands') return { action, commands: c.commands, stopOnFailure: c.stopOnFailure, onMissing: c.onMissing };
  if (action !== 'waitForCi') return { action };
  return { action, ciChecks: c.ciChecks, ...(c.ciChecks === 'list' ? { checks: c.checks } : {}), rerunOnce: c.rerunOnce, ...optional('timeout', c.timeout) };
}

/** A draft map keyed by row id as the config's, keyed by the rows' trimmed names in row order (#180); a removed row's entry and an empty list
 * are left out (#515). */
export const named = <T>(map: Record<string, T[]>, rows: readonly StageRow[]): Record<string, T[]> =>
  Object.fromEntries(rows.flatMap((r) => ((map[r.id]?.length ?? 0) === 0 ? [] : [[r.name.trim(), map[r.id]]])));

// The keys of a stage that runs an agent (#710): its session, model, agent, specialized agent, approval, worker cap, handoff (#692) and its own
// verdicts (#134). runs: a prompt typed or a skill: only then a handoff or a specialized agent, which the parser refuses on a stage that runs nothing
const agentKeys = (c: StageDraft, runs: boolean): Partial<Stage> => ({
  ...(c.session === 'continue' ? { session: 'continue' as const } : {}), ...optional('model', c.model), ...(c.agent === '' ? {} : { agent: c.agent }),
  ...(c.approval ? { approval: true as const } : {}), ...(c.maxWorkers.trim() === '' ? {} : { maxWorkers: Number(c.maxWorkers.trim()) }), // #475: a delete activity stage runs no worker, so it sends no cap
  ...(c.handoff && c.session !== 'continue' && runs ? { handoff: true as const } : {}), // #692: off under continue or with nothing to run
  ...(runs ? optional('specializedAgent', c.specializedAgent) : {}),
  ...(c.verdicts.length === 0 ? {} : { verdicts: c.verdicts }),
});
const promptKeys = (c: StageDraft): Partial<Stage> => ({ ...agentKeys(c, c.prompt.trim() !== ''), ...optional('prompt', c.prompt) });
// #710: a skill stage's skill is chosen, not typed: every key but prompt; an empty skill is validateSettings' to refuse
const skillKeys = (c: StageDraft): Partial<Stage> => ({ action: 'skill', ...optional('skill', c.skill), ...agentKeys(c, true) });

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean; the server validates the rest
export const stageFrom = (c: StageDraft, rows: StageRow[]): Stage => {
  const run = c.action === 'skill' ? skillKeys(c) : c.action !== '' ? actionKeys(c, c.action) : isGateDraft(c) ? { approval: true as const } : promptKeys(c); // #134: a gate sends approval alone
  const onStart = named(c.onStart, rows);
  return { name: c.name.trim(), from: named(c.from, rows), ...(Object.keys(onStart).length === 0 ? {} : { onStart }), ...run, ...optional('after', c.after) };
};

// #515: what one sai cell may still take. One of each type, so one move at most; no leaving action on start (the worker still runs on the
// task) and only one per list. The parser holds the same rules; the form only offers what passes them.
export function addableActions(list: readonly SourceAction[], type: SourceFields['type'], columns: readonly string[], onStart: boolean): SourceAction[] {
  const has = (t: SourceAction['type']): boolean => list.some((a) => a.type === t);
  const leavingIn = list.some(isLeaving);
  const moves: SourceAction[] = has('move') ? [] : columns.map((column) => ({ type: 'move', column }));
  const others = SOURCE_ACTIONS[type].filter((t): t is ItemAction['type'] => t !== 'move' && !has(t) && !(LEAVING_ACTIONS.includes(t) && (onStart || leavingIn)));
  return [...moves, ...others.map((t): ItemAction => ({ type: t }))];
}

/** The list with `action` added (#515): before a leaving action already last, so it stays last. */
export function withAction(list: readonly SourceAction[], action: SourceAction): SourceAction[] {
  const last = list.at(-1);
  return last !== undefined && isLeaving(last) && !isLeaving(action) ? [...list.slice(0, -1), action, last] : [...list, action];
}
export const withoutAction = (list: readonly SourceAction[], index: number): SourceAction[] => list.filter((_, i) => i !== index);

/** An action as its chip and menu read it (#515). */
export const actionLabel = (a: SourceAction): string =>
  (a.type === 'move' ? t('settings.stages.finish.move', { column: a.column }) : t(`settings.stages.finish.${a.type}`));

/** A manual gate (#315): requires approval on a prompt stage whose prompt is blank. Nothing starts there, so on start is never written. */
export const isGateDraft = (stage: StageDraft): boolean => stage.action === '' && (stage.gate || (stage.approval && stage.prompt.trim() === ''));

/** A stage whose action is an agent's (#710): a prompt stage, its prompt typed or still blank, or a skill stage; never a gate. What shows the run
 * fields, the verdicts editor and the handoff, and what a transition's session may continue. */
export const isAgentDraft = (stage: StageDraft): boolean => stage.action === 'skill' || (stage.action === '' && !isGateDraft(stage));

/** A stage chip's second line (#515): what the stage does, or the agent it runs (#516) and the prompt's first word. */
export function stageMeta(s: StageDraft, defaultAgent: AgentId): string {
  if (s.action === 'deleteActivity') return t('settings.stages.meta.deleteActivity');
  if (s.action === 'waitForCi') { // #834: the checks it counts; required and all read as their option
    if (s.ciChecks !== 'list') return t(s.ciChecks === 'all' ? 'settings.stages.ci.which.all' : 'settings.stages.ci.which.required');
    return s.checks.length > 0 ? s.checks.join(', ') : t('settings.stages.action.waitForCi');
  }
  if (s.action === 'commands') return s.commands.length > 0 ? s.commands.join(', ') : t('settings.stages.action.commands'); // #755: what it runs
  // #710: the agent and the skill, as a prompt stage's reads the agent and its first word
  if (s.action === 'skill') return `${s.agent === '' ? defaultAgent : s.agent} · ${s.skill === '' ? t('settings.stages.action.skill') : s.skill}`;
  if (isGateDraft(s)) return t('settings.stages.meta.gate');
  const prompt = s.prompt.trim();
  if (prompt === '') return t('settings.stages.meta.show');
  const word = prompt.split(/\s+/)[0].replace(/^\/+/, '').slice(0, META_WORD_MAX);
  return `${s.agent === '' ? defaultAgent : s.agent} · ${word}`;
}

// #515: the entry multi-select spans every source, so a value carries its row id and its column. Row ids are UUIDs (no ':'), so the first
// ':' splits and a column holding one survives.
export const entryKey = (rowId: string, column: string): string => `${rowId}:${column}`;
// Only the current rows' entries: a removed source's would read as a bare column that no longer feeds the stage.
export const entryKeys = (from: Record<string, string[]>, rows: readonly StageRow[]): string[] =>
  rows.flatMap((r) => (from[r.id] ?? []).map((c) => entryKey(r.id, c)));

const splitKey = (key: string): [string, string] => {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
};

export function fromKeys(keys: readonly string[]): Record<string, string[]> {
  const split = keys.map(splitKey);
  const rows = [...new Set(split.map(([row]) => row))];
  return Object.fromEntries(rows.map((row) => [row, split.flatMap(([r, column]) => (r === row ? [column] : []))]));
}

/** An entry as the multi-select shows it: "source · column", an unnamed source as its place (#n). */
export function entryLabel(key: string, rows: readonly StageRow[]): string {
  const [row, column] = splitKey(key);
  const index = rows.findIndex((r) => r.id === row);
  const name = index === -1 ? '' : rows[index].name.trim() || `#${index + 1}`;
  return name === '' ? column : `${name} · ${column}`;
}

/** The stages loaded under another name (#861): saved name → trimmed new name. A new stage renames nothing. */
export const stageRenamesFrom = (drafts: readonly StageDraft[]): Record<string, string> =>
  Object.fromEntries(drafts.flatMap((d) => (d.savedName === undefined || d.name.trim() === d.savedName ? [] : [[d.savedName, d.name.trim()]])));

/** How many tasks a save's deleted stages send to one stage (#861). */
export interface StageMove { stage: string; n: number }

/** Where a save's deleted stages send their tasks (#861), per destination, under the new names: `saved` is the config's stages, `next` the ones
 * the save sends; [] when no deleted stage holds a task. The reducer's own rule, so the confirmation says what the save will do. */
export function deletionMoves(drafts: readonly StageDraft[], saved: readonly Stage[], next: Stage[], tasks: readonly Task[]): StageMove[] {
  const renames = stageRenamesFrom(drafts);
  const kept = new Set(drafts.flatMap((d) => (d.savedName === undefined ? [] : [d.savedName])));
  const old = saved.map((s) => ({ name: Object.hasOwn(renames, s.name) ? renames[s.name] : s.name }));
  const destinations = tasks.flatMap((task) => {
    if (kept.has(task.stage) || !saved.some((s) => s.name === task.stage)) return [];
    const to = destinationOf(task, task.stage, old, next);
    return to === undefined ? [] : [to.name];
  });
  return [...new Set(destinations)].map((stage) => ({ stage, n: destinations.filter((d) => d === stage).length }));
}

/** The deletion confirmation's text (#861): one line per destination. */
export const deletionMessage = (moves: readonly StageMove[]): string =>
  [t('settings.stages.deleteMoves.message'), ...moves.map((m) => tPlural('settings.stages.deleteMoves.move', m.n, { n: m.n, stage: m.stage }))].join('\n');
