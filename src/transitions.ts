import { stageAgentIn } from './agents.js';
import { stageSession } from './task-runs.js';
import { sessionsOf } from './tasks.js';
import { FIXED_VERDICTS, TRIES_OUT, type Activity, type AgentId, type Stage, type State, type Task, type Transition, type Trigger } from './types.js';

// The flow as a graph (#134): which transition a stage end fires, the session and the prompt it hands its destination, and the tries an
// automatic one counts. Pure and free of node modules, since the page reads it too; no state is written here, transit.ts applies the answers.

/** The stages and transitions a stage end is read against: State's, or the config's. */
export interface Graph { stages: readonly Stage[]; transitions: readonly Transition[] }

/** A transition's key (#134): its (from, when, verdict) triple as JSON, so free-text stage names never collide. What tries and via keep. */
export const transitionKey = ({ from, when, verdict }: Pick<Transition, 'from' | 'when' | 'verdict'>): string => JSON.stringify([from, when, verdict ?? null]);

/** The transition a key names, while the flow still has it. */
export const transitionByKey = (transitions: readonly Transition[], key: string | undefined): Transition | undefined =>
  (key === undefined ? undefined : transitions.find((t) => transitionKey(t) === key));

/** A transition the stage fires itself (#134): it may loop, so it counts tries. approved and feedback are the user's, with no limit. */
export const isAutomatic = (when: Trigger): boolean => when === 'done' || when === 'verdict';

/** The transitions leaving `stage`, in the config's order. */
export const outgoing = (transitions: readonly Transition[], stage: string): Transition[] => transitions.filter((t) => t.from === stage);

const matching = (transitions: readonly Transition[], from: string, when: Trigger, verdict?: string): Transition | undefined =>
  transitions.find((t) => t.from === from && t.when === when && t.verdict === verdict);

/** The transition a stage end fires (#134): the one whose (from, when, verdict) matches. An agent's verdict with no transition of its own falls
 * back to done on a stage without approval (an approval stage waits for the user instead); a commands or wait-for-CI verdict never falls back,
 * so a failed check never passes as finished. Undefined when nothing matches. */
export function exitOf(graph: Graph, stage: string, trigger: Trigger, verdict?: string): Transition | undefined {
  const own = matching(graph.transitions, stage, trigger, trigger === 'verdict' ? verdict : undefined);
  if (own !== undefined || trigger !== 'verdict') return own;
  const origin = graph.stages.find((s) => s.name === stage);
  return origin !== undefined && origin.action === undefined && origin.approval !== true ? matching(graph.transitions, stage, 'done') : undefined;
}

/** Whether the user's answer has somewhere to go (#134): a transition for it, or a stage gone from the flow, which lets the task leave. Here,
 * free of node modules, so the page reads the rule the approval routes check (#379). */
export const answerable = (graph: Graph, task: Pick<Task, 'stage'>, trigger: Trigger): boolean =>
  exitOf(graph, task.stage, trigger) !== undefined || !graph.stages.some((s) => s.name === task.stage);

/** A stage end as NO_TRANSITION and TRIES_OUT write it (#134): the trigger, or verdict:<name>. */
export const exitName = (trigger: Trigger, verdict?: string): string => (trigger === 'verdict' ? `verdict:${verdict ?? ''}` : trigger);

/** The transition whose tries ran out on the task (#915): the one leaving its stage whose exit the TRIES_OUT error names, only the limit after
 * it; undefined for any other error, or once a save removed or renamed that transition. (from, when, verdict) is unique, so the exit names one. */
export function retryTransition(state: Pick<State, 'transitions'>, task: Task, error: string | undefined): Transition | undefined {
  if (error === undefined || !error.startsWith(TRIES_OUT)) return undefined;
  return outgoing(state.transitions, task.stage).find((t) => {
    const prefix = `${TRIES_OUT}${exitName(t.when, t.verdict)} · `;
    return error.startsWith(prefix) && /^\d+$/.test(error.slice(prefix.length));
  });
}

/** The verdicts a stage may give (#134): its own on a prompt stage, the fixed ones on commands and wait for CI, none on any other. */
export function verdictsOf(stage: Pick<Stage, 'action' | 'prompt' | 'verdicts'>): readonly string[] {
  if (stage.action === 'commands' || stage.action === 'waitForCi') return FIXED_VERDICTS;
  return stage.action === undefined && stage.prompt !== undefined ? stage.verdicts ?? [] : [];
}

/** The session a transition hands its destination (#134). */
export type ResolvedSession = { policy: 'new' } | { policy: 'continue'; sessionId: string };

/** Whether a stage run of `agent` may resume session `id` (#925): one agent never resumes another's session. A session the records do not list
 * keeps the continue it always had. */
export const resumableBy = (state: Pick<State, 'activityRecords'>, task: Task, id: string, agent: AgentId): boolean =>
  (sessionsOf(state, task.item.itemId).find((s) => s.id === id)?.agent ?? agent) === agent;

/** previous: the session the activity holds, the run that just ended; continueOf: the task's last session that ran in that stage; new: a new
 * one; absent: the destination's own policy, as a stage end decided it before. Nothing to resume is a new session. A session of another agent
 * than the destination's is nothing to resume (#925). */
export function resolveSession(
  state: Pick<State, 'activityRecords' | 'defaultAgent'>, task: Task, activity: Pick<Activity, 'sessionId'> | undefined, transition: Pick<Transition, 'session'>,
  destination: Pick<Stage, 'session' | 'agent'>,
): ResolvedSession {
  const agent = stageAgentIn(state, destination);
  // #925: a session of another agent resolves as nothing to resume: the destination starts its own
  const resume = (id: string | undefined): ResolvedSession => (id === undefined || !resumableBy(state, task, id, agent) ? { policy: 'new' } : { policy: 'continue', sessionId: id });
  const { session } = transition;
  if (session === 'new') return { policy: 'new' };
  if (session === 'previous') return resume(activity?.sessionId);
  if (session !== undefined) return resume(stageSession(task, state, session.continueOf)?.id);
  return destination.session === 'continue' ? resume(activity?.sessionId) : { policy: 'new' };
}

/** The line before the user's feedback (#268). A transition's own prompt may still open on {feedback} or {verdict}: spawn.ts's writePrompt
 * guards every prompt that reaches claude's argv. */
export const FEEDBACK_LEAD = 'The user reviewed this stage and asks:';
/** A feedback transition's prompt when it has none of its own (#134): the feedback behind its lead, as a resumed run always read it. */
export const FEEDBACK_TEMPLATE = `${FEEDBACK_LEAD}\n\n{feedback}`;

/** The template a transition tells its destination (#134): a new session reads the transition's prompt, a blank line, the destination's; a
 * continued one already holds its stage's prompt, so the transition's alone, or the destination's when the transition has none. */
export function transitionPrompt(transition: Pick<Transition, 'when' | 'prompt'>, destination: Pick<Stage, 'prompt'>, policy: 'new' | 'continue'): string {
  const own = transition.prompt !== undefined && transition.prompt.trim() !== '' ? transition.prompt : transition.when === 'feedback' ? FEEDBACK_TEMPLATE : '';
  const stage = destination.prompt ?? '';
  if (policy === 'continue') return own !== '' ? own : stage;
  return [own, stage].filter((part) => part.trim() !== '').join('\n\n');
}

/** Whether a transition says more than its destination would (#134): a prompt of its own, a feedback, a session of its own. Only then is a
 * handover written; any other move leaves the destination's run to its stage's own prompt and session. */
export const needsHandover = (transition: Pick<Transition, 'when' | 'prompt' | 'session'>): boolean =>
  (transition.prompt !== undefined && transition.prompt.trim() !== '') || transition.when === 'feedback' || transition.session !== undefined;

/** One more try through an automatic transition with maxTries (#134): the activity's tries with this one counted, or undefined once they ran
 * out. A transition with no limit, or a user's, counts nothing. */
export function takeTry(activity: Pick<Activity, 'tries'> | undefined, transition: Transition): Record<string, number> | undefined {
  const tries = activity?.tries ?? {};
  if (!isAutomatic(transition.when) || transition.maxTries === undefined) return tries;
  const key = transitionKey(transition);
  const taken = tries[key] ?? 0;
  return taken >= transition.maxTries ? undefined : { ...tries, [key]: taken + 1 };
}

/** What {verdict} renders (#134): a commands or wait-for-CI verdict's output, an agent verdict's evidence, empty otherwise. */
export function verdictText(origin: Pick<Stage, 'action'> | undefined, result: Record<string, unknown> | undefined): string {
  const field = origin?.action === 'commands' ? result?.commands : origin?.action === 'waitForCi' ? result?.ci : result?.verdict;
  const key = origin?.action === undefined ? 'evidence' : 'output';
  const value = typeof field === 'object' && field !== null ? (field as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : '';
}
