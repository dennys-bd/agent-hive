import { isGate } from '../../tasks.js';
import { DEFAULT_AGENT, type Stage, type Transition, type Trigger } from '../../types.js';
import { t } from '../i18n.js';

// What the flowchart and the card write for a transition (#134): the fixed verdicts and the triggers in the viewer's language, an agent's own
// verdicts as the config writes them.

/** A verdict as a pill reads it: passed / failed translated, any other as written. */
export const verdictLabel = (verdict: string): string =>
  (verdict === 'passed' ? t('flow.verdict.passed') : verdict === 'failed' ? t('flow.verdict.failed') : verdict);

/** A trigger as a pill reads it: the verdict's word, or the trigger's. */
export const triggerLabel = (when: Trigger, verdict?: string): string => (when === 'verdict' ? verdictLabel(verdict ?? '') : t(`flow.trigger.${when}`));

/** An exit as NO_TRANSITION and TRIES_OUT store it (`approved`, `verdict:failed`), as the card writes it. */
export function exitLabel(name: string): string {
  if (name.startsWith('verdict:')) return verdictLabel(name.slice('verdict:'.length));
  return name === 'done' || name === 'approved' || name === 'feedback' ? triggerLabel(name) : name;
}

/** A transition's pill (#134): its own label, else its trigger's; an automatic one with a limit adds it, `falhou · 3x`. */
export function transitionLabel(transition: Pick<Transition, 'when' | 'verdict' | 'label' | 'maxTries'>): string {
  const label = transition.label ?? triggerLabel(transition.when, transition.verdict);
  return transition.maxTries === undefined ? label : t('flow.tries', { label, n: transition.maxTries });
}

/** Whether the flow view draws a transition's pill (#908): the default path, a `done` or `approved` arrow forward, goes unlabelled; its own
 * label, a back edge, a loop and any other trigger keep theirs. Settings draws every pill: there a pill is the button that selects it. */
export const showsPill = (transition: Pick<Transition, 'from' | 'to' | 'when' | 'label'>, isBack: boolean): boolean =>
  transition.label !== undefined || isBack || transition.from === transition.to || (transition.when !== 'done' && transition.when !== 'approved');

/** Who runs a node, on one line (#134): the agent and its model, then the approval wait when it asks for one; the commands; the checks a wait
 * counts; the delete activity; the approval wait for a gate; only-shows for a stage with nothing to run. */
export function executorLine(stage: Stage): string {
  if (stage.action === 'commands') return (stage.commands ?? []).join(', ');
  if (stage.action === 'waitForCi') {
    if (stage.ciChecks === 'list') return (stage.checks ?? []).join(', ');
    return t(stage.ciChecks === 'all' ? 'settings.stages.ci.which.all' : 'settings.stages.ci.which.required');
  }
  if (stage.action === 'deleteActivity') return t('settings.stages.meta.deleteActivity');
  if (isGate(stage)) return t('settings.stages.meta.gate');
  if (stage.prompt === undefined) return t('settings.stages.meta.show');
  const who = [stage.agent ?? DEFAULT_AGENT, ...(stage.model === undefined ? [] : [stage.model])].join(' · ');
  return stage.approval ? `${who} · ${t('settings.stages.meta.gate')}` : who;
}
