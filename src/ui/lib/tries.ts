import { transitionByKey, transitionKey } from '../../transitions.js';
import type { Activity, State } from '../../types.js';
import { triggerLabel } from './flow-labels.js';

/** The tries of the transition the task came through (#134, #914): its trigger's label, the tries taken, its limit. A type, so it passes as t()'s
 * vars. */
export type ViaTries = { label: string; n: number; max: number };

/** What the card's `falhou · 1/3` and the running block's `volta 2/3` read; undefined on an arrow with no limit. */
export function viaTries(state: Pick<State, 'transitions'>, activity: Pick<Activity, 'via' | 'tries'> | undefined): ViaTries | undefined {
  const via = transitionByKey(state.transitions, activity?.via);
  if (via?.maxTries === undefined) return undefined;
  return { label: triggerLabel(via.when, via.verdict), n: activity?.tries?.[transitionKey(via)] ?? 0, max: via.maxTries };
}
