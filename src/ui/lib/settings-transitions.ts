import { isAutomatic, transitionKey } from '../../transitions.js';
import { END, FIXED_VERDICTS, type SourceAction, type Transition, type TransitionSession, type Trigger } from '../../types.js';
import { t } from '../i18n.js';
import { triggerLabel } from './flow-labels.js';
import { byRow, isGateDraft, named, optional, type StageDraft, type StageRow } from './settings-stages.js';

// Settings › fluxo's transitions (#134): the draft ↔ Transition edges, keyed by the stage drafts' ids so a stage renamed while it is edited keeps
// its arrows, the choices the editor offers, and the form's own check before the server's.

/** A transition as the form edits it (#134). from / to: stage draft ids (to: END too); session: '' (the destination's), previous, new, or a stage
 * draft id to continue; maxTries as typed; sources keyed by source row id. id: a React key, never sent. */
export interface TransitionDraft {
  id: string; from: string; to: string; when: Trigger; verdict: string; label: string; prompt: string;
  session: '' | 'previous' | 'new' | { continueOf: string }; maxTries: string; sources: Record<string, SourceAction[]>;
}

const idOf = (stages: readonly StageDraft[], name: string): string => stages.find((s) => s.name.trim() === name)?.id ?? '';
const nameOf = (stages: readonly StageDraft[], id: string): string => stages.find((s) => s.id === id)?.name.trim() ?? '';

// A stage as the chart and the editor's title name it: fim for the end, sem nome for a blank one or one gone
const shownName = (stages: readonly StageDraft[], id: string): string => (id === END ? t('flow.end') : nameOf(stages, id) || t('settings.stages.unnamed'));

/** A transition as the chart names it (#134): `Plan → Review · terminou`, the editor's title and the form's messages (#918). */
export const draftTitle = (d: TransitionDraft, stages: readonly StageDraft[]): string =>
  `${shownName(stages, d.from)} → ${shownName(stages, d.to)} · ${triggerLabel(d.when, d.verdict)}`;

export function transitionDraft(t: Transition, stages: readonly StageDraft[], rows: readonly StageRow[]): TransitionDraft {
  const session = t.session === undefined ? '' : typeof t.session === 'string' ? t.session : { continueOf: idOf(stages, t.session.continueOf) };
  return {
    id: crypto.randomUUID(), from: idOf(stages, t.from), to: t.to === END ? END : idOf(stages, t.to), when: t.when, verdict: t.verdict ?? '', label: t.label ?? '',
    prompt: t.prompt ?? '', session, maxTries: t.maxTries === undefined ? '' : String(t.maxTries), sources: byRow(t.sources, rows),
  };
}

// Absent keys stay absent, so hive.config.json stays clean: a verdict only with its trigger, tries only on an automatic one
export function transitionFrom(d: TransitionDraft, stages: readonly StageDraft[], rows: readonly StageRow[]): Transition {
  const session: TransitionSession | undefined = d.session === '' ? undefined : typeof d.session === 'string' ? d.session : { continueOf: nameOf(stages, d.session.continueOf) };
  const sources = named(d.sources, rows);
  return {
    from: nameOf(stages, d.from), to: d.to === END ? END : nameOf(stages, d.to), when: d.when, ...(d.when === 'verdict' ? { verdict: d.verdict } : {}),
    ...optional('label', d.label), ...(d.prompt.trim() === '' ? {} : { prompt: d.prompt }), ...(session === undefined ? {} : { session }),
    ...(isAutomatic(d.when) && d.maxTries.trim() !== '' ? { maxTries: Number(d.maxTries.trim()) } : {}), ...(Object.keys(sources).length === 0 ? {} : { sources }),
  };
}

/** The verdicts a stage draft gives (#134): the fixed ones on commands and wait for CI, its own on a prompt stage, none otherwise. */
export function draftVerdicts(stage: StageDraft): readonly string[] {
  if (stage.action === 'commands' || stage.action === 'waitForCi') return FIXED_VERDICTS;
  return stage.action === '' && !isGateDraft(stage) ? stage.verdicts : [];
}

/** The triggers a stage draft may fire, as the parser allows them (#134): approved and feedback on approval; done on any other stage that ends
 * by itself; verdict when it has verdicts. A commands or wait-for-CI stage only ends with a verdict. */
export function triggersOf(stage: StageDraft): Trigger[] {
  const verdict: Trigger[] = draftVerdicts(stage).length > 0 ? ['verdict'] : [];
  if (stage.approval || isGateDraft(stage)) return ['approved', 'feedback', ...verdict];
  return stage.action === 'commands' || stage.action === 'waitForCi' ? verdict : ['done', ...verdict];
}

/** A new arrow from `from` (#134): to the next stage in the array, or end after the last, by the trigger its end fires first. */
export function emptyTransition(from: StageDraft, stages: readonly StageDraft[]): TransitionDraft {
  const next = stages[stages.findIndex((s) => s.id === from.id) + 1];
  const [when] = triggersOf(from);
  return {
    id: crypto.randomUUID(), from: from.id, to: next?.id ?? END, when: when ?? 'done', verdict: when === 'verdict' ? draftVerdicts(from)[0] ?? '' : '',
    label: '', prompt: '', session: '', maxTries: '', sources: {},
  };
}

/** The transitions once a stage is removed (#134): its arrows go with it, and a session that continued it falls back to the destination's. */
export const withoutStage = (transitions: readonly TransitionDraft[], id: string): TransitionDraft[] =>
  transitions.filter((d) => d.from !== id && d.to !== id).map((d) => (typeof d.session === 'object' && d.session.continueOf === id ? { ...d, session: '' } : d));

/** The transitions once the stage list changed (#134): the arrows of a stage that left the list go with it. */
export function transitionsKept(transitions: readonly TransitionDraft[], stages: readonly StageDraft[]): TransitionDraft[] {
  const gone = [...new Set(transitions.flatMap((d) => [d.from, d.to]))].filter((id) => id !== END && !stages.some((s) => s.id === id));
  return gone.reduce((list, id) => withoutStage(list, id), [...transitions]);
}

/** The transitions once a stage's approval switch moved (#918): a stage with approval is only left by approved, so its done exits become approved,
 * and turning it off undoes that. Its verdict and feedback exits and every other stage's stay as they are. */
export function withApproval(transitions: readonly TransitionDraft[], stageId: string, approval: boolean): TransitionDraft[] {
  const [from, to]: [Trigger, Trigger] = approval ? ['done', 'approved'] : ['approved', 'done'];
  return transitions.map((d) => (d.from === stageId && d.when === from ? { ...d, when: to } : d));
}

/** A transition's pill (#134): its own label, else its trigger's, with its tries on an automatic one. */
export function draftLabel(d: TransitionDraft): string {
  const label = d.label.trim() || triggerLabel(d.when, d.verdict);
  return isAutomatic(d.when) && /^[1-9]\d*$/.test(d.maxTries.trim()) ? t('flow.tries', { label, n: d.maxTries.trim() }) : label;
}

/** Why the parser would refuse a transition (#134, #918): `settings.transitions.error.<reason>` says it. */
export type TransitionReason = 'ends' | 'verdict' | 'tries' | 'twin' | 'needsApproval' | 'useApproved' | 'useVerdict' | 'gateFeedback';

// One transition against the parser's rules, in parseTransition's order (config-transitions.ts). The trigger rules read triggersOf, so the
// form and the parser keep one rule; tries count only on an automatic trigger, as transitionFrom sends them only there.
function reasonOf(d: TransitionDraft, stages: readonly StageDraft[], isTwin: boolean): TransitionReason | undefined {
  const origin = stages.find((s) => s.id === d.from);
  if (origin === undefined || (d.to !== END && !stages.some((s) => s.id === d.to))) return 'ends';
  if (d.when === 'verdict' && !draftVerdicts(origin).includes(d.verdict)) return 'verdict';
  if (!triggersOf(origin).includes(d.when)) return d.when !== 'done' ? 'needsApproval' : origin.approval || isGateDraft(origin) ? 'useApproved' : 'useVerdict';
  if (d.when === 'feedback' && d.to === origin.id && isGateDraft(origin)) return 'gateFeedback';
  if (isAutomatic(d.when) && d.maxTries.trim() !== '' && !/^[1-9]\d*$/.test(d.maxTries.trim())) return 'tries';
  return isTwin ? 'twin' : undefined;
}

/** The first transition the parser would refuse (#134), in list order, by its draft id and why (#918). The server checks the rest. */
export function transitionsProblem(transitions: readonly TransitionDraft[], stages: readonly StageDraft[]): { id: string; reason: TransitionReason } | undefined {
  const keys = transitions.map((d) => transitionKey({ from: d.from, when: d.when, verdict: d.when === 'verdict' ? d.verdict : undefined }));
  for (const [i, d] of transitions.entries()) {
    const reason = reasonOf(d, stages, keys.indexOf(keys[i]) !== i);
    if (reason !== undefined) return { id: d.id, reason };
  }
  return undefined;
}
