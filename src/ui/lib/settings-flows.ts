import { isFlowName, MAIN_FLOW } from '../../flows.js';
import { timeoutMs } from '../../timeout.js';
import type { AgentId, Flow } from '../../types.js';
import { t } from '../i18n.js';
import type { SettingsDraft, SettingsProblem } from './settings-form.js';
import { badEvaluation, emptyStage, isEmptyOrDuration, isEmptyOrNonNegativeInt, orphanContinue, stageFrom, stageNameClash, type StageDraft } from './settings-stages.js';
import { draftTitle, type TransitionDraft, transitionFrom, transitionsKept, transitionsProblem } from './settings-transitions.js';

// Settings › fluxo's flows (#565), out of settings-form.ts, which is at its limit: the draft keeps flat stage and transition lists in flow order,
// each stage tagged with its flow; these edges scope, merge and send them, and judge the flows.

export interface FlowDraft { id: string; name: string } // id: a React key and what a StageDraft's flow holds, never sent; name as typed
export interface ScopedFlow { stages: StageDraft[]; transitions: TransitionDraft[] }
type FlowsDraft = Pick<SettingsDraft, 'flows' | 'stages' | 'transitions'>;

const emptyFlow = (name: string): FlowDraft => ({ id: crypto.randomUUID(), name });

/** One draft per saved flow; an empty config gets one named MAIN_FLOW, the name the parser's migration gives a flat comb (#564). */
export const flowDrafts = (saved: readonly Flow[]): FlowDraft[] => (saved.length === 0 ? [emptyFlow(MAIN_FLOW)] : saved.map((f) => emptyFlow(f.name)));

export const flowOfStage = (stages: readonly StageDraft[], id: string | undefined): string | undefined => stages.find((s) => s.id === id)?.flow;

export function scopedFlow(draft: FlowsDraft, flow: string): ScopedFlow {
  const stages = draft.stages.filter((s) => s.flow === flow);
  return { stages, transitions: draft.transitions.filter((d) => stages.some((s) => s.id === d.from)) };
}

/** The flat lists with `flow`'s part replaced by `next` (the stage editor's change), every flow in its draft order; the arrows of a stage that
 * left the list go with it (transitionsKept). */
export function withFlowEdit(draft: FlowsDraft, flow: string, next: ScopedFlow): ScopedFlow {
  const kept = transitionsKept(next.transitions, next.stages);
  return {
    stages: draft.flows.flatMap((f) => (f.id === flow ? next.stages : scopedFlow(draft, f.id).stages)),
    transitions: draft.flows.flatMap((f) => (f.id === flow ? kept : scopedFlow(draft, f.id).transitions)),
  };
}

/** + fluxo > criar (spec decision 1): the flow with one empty stage and no transition, since the parser needs a stage per flow. */
export function withNewFlow(draft: FlowsDraft, name: string, defaultAgent: AgentId): { id: string; patch: Pick<SettingsDraft, 'flows' | 'stages'> } {
  const flow = emptyFlow(name.trim());
  return { id: flow.id, patch: { flows: [...draft.flows, flow], stages: [...draft.stages, emptyStage(flow.id, defaultAgent)] } };
}

export function withoutFlow(draft: FlowsDraft, flow: string): FlowsDraft {
  const flows = draft.flows.filter((f) => f.id !== flow);
  return { flows, stages: draft.stages.filter((s) => s.flow !== flow), transitions: flows.flatMap((f) => scopedFlow(draft, f.id).transitions) };
}

/** parseFlows' name rules (#564): non-empty once trimmed, and unique among the draft's flows (`id`, the flow being renamed, excepted). */
export function flowNameProblem(name: string, flows: readonly FlowDraft[], id?: string): 'settings.flows.error.name' | 'settings.flows.error.duplicate' | undefined {
  const trimmed = name.trim();
  if (!isFlowName(trimmed)) return 'settings.flows.error.name';
  return flows.some((f) => f.id !== id && f.name.trim() === trimmed) ? 'settings.flows.error.duplicate' : undefined;
}

/** The flows the parser would refuse (#565), first problem wins: a flow name, a flow with no stage, then a stage name another flow holds,
 * pointing at the later of the two stages, the one being edited. */
export function flowsProblem({ flows, stages }: Pick<SettingsDraft, 'flows' | 'stages'>): SettingsProblem | undefined {
  const named = flows.find((f) => flowNameProblem(f.name, flows, f.id) !== undefined);
  const key = named && flowNameProblem(named.name, flows, named.id);
  if (named && key) return { section: 'flow', message: t(key, { name: named.name.trim() }) };
  const empty = flows.find((f) => !stages.some((s) => s.flow === f.id));
  if (empty) return { section: 'flow', message: t('settings.flows.error.empty', { flow: empty.name.trim() }) };
  const clash = stages.filter((s) => stageNameClash(stages, flows, s.id) !== undefined).at(-1);
  const holder = clash && stageNameClash(stages, flows, clash.id);
  return clash && holder ? { section: 'flow', message: t('settings.stages.error.otherFlow', { flow: holder }), stage: clash.id } : undefined;
}

/** The body's flows (#565): each flow's stages in draft order and each transition under its from stage's flow, names trimmed. */
export function flowsFrom({ flows, stages, transitions, sources }: FlowsDraft & Pick<SettingsDraft, 'sources'>): Flow[] {
  return flows.map((f) => {
    const own = scopedFlow({ flows, stages, transitions }, f.id);
    return { name: f.name.trim(), stages: own.stages.map((c) => stageFrom(c, sources)), transitions: own.transitions.map((d) => transitionFrom(d, stages, sources)) };
  });
}

// #134, #918: the first arrow the parser would refuse, named as the chart names it, with its id so Settings selects it
export function transitionsDraftProblem(draft: SettingsDraft): SettingsProblem | undefined {
  const bad = transitionsProblem(draft.transitions, draft.stages);
  const transition = draft.transitions.find((d) => d.id === bad?.id);
  if (bad === undefined || transition === undefined) return undefined;
  const stage = draft.stages.find((s) => s.id === transition.from)?.name.trim() || t('settings.stages.unnamed');
  const message = t(`settings.transitions.error.${bad.reason}`, { name: draftTitle(transition, draft.stages), stage });
  return { section: 'flow', message, transition: bad.id };
}

// #834: a wait for CI needs a check under só estes, and its wait in the TIMEOUT grammar; an empty wait is no limit
const badWait = (c: StageDraft): boolean =>
  c.action === 'waitForCi' && ((c.ciChecks === 'list' && c.checks.length === 0) || (c.timeout.trim() !== '' && timeoutMs(c.timeout) === undefined));

// #598: a wait's queue limit in the TIMEOUT grammar; an empty one is no limit
const badQueue = (c: StageDraft): boolean => c.action === 'waitForCi' && c.queueTimeout.trim() !== '' && timeoutMs(c.queueTimeout) === undefined;

export function stagesProblem(stages: StageDraft[], defaultAgent: AgentId): SettingsProblem | undefined {
  if (stages.length === 0) return { section: 'flow', message: t('settings.stages.none') };
  const bad = stages.findIndex((c) => c.name.trim() === '' || !isEmptyOrDuration(c.after) || !isEmptyOrNonNegativeInt(c.maxWorkers) || (c.action === 'commands' && c.commands.length === 0)); // #755: the parser refuses an empty list
  if (bad !== -1) return { section: 'flow', message: t('settings.stages.error', { n: bad + 1 }) };
  const unpicked = stages.findIndex((c) => c.action === 'skill' && c.skill === ''); // #710: a skill stage with none runs nothing; the parser refuses it
  if (unpicked !== -1) return { section: 'flow', message: t('settings.stages.error.skill', { n: unpicked + 1 }) };
  const orphan = orphanContinue(stages, defaultAgent); // #710: the first stage of an agent has no session of it to continue
  if (orphan !== -1) return { section: 'flow', message: t('settings.stages.error.continue', { n: orphan + 1, agent: stages[orphan]?.agent || defaultAgent }) };
  const wait = stages.findIndex(badWait);
  if (wait !== -1) return { section: 'flow', message: t('settings.stages.error.ci', { n: wait + 1 }) };
  const queued = stages.find(badQueue);
  if (queued) return { section: 'flow', message: t('settings.error.queueTimeout', { stage: queued.name.trim() }) };
  const judged = stages.findIndex(badEvaluation); // #877: the parser refuses each one
  return judged === -1 ? undefined : { section: 'flow', message: t('settings.stages.error.evaluate', { n: judged + 1 }) };
}
