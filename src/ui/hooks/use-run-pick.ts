import { useState } from 'react';
import { runModel } from '../../agents';
import { previousSession, stageOf, worktreeSessions } from '../../tasks';
import type { AgentId, LaunchPick, Session, State, Task } from '../../types';
import { launchOf, type SessionPicks } from '@/lib/new-session';

/** sessão's values besides a session id, which is a uuid and never one of these; Radix Select rejects value="" (#237). */
export const NEW_SESSION = 'new';
export const PREVIOUS_SESSION = 'previous';

/** A run's five fields (#290): #257's four and the session: NEW_SESSION, PREVIOUS_SESSION or a session id. A model of '' is runModel's chain
 * (the stage's model, else the agent's default), never "no model". */
export interface RunPicks extends SessionPicks { session: string }
export type RunField = keyof RunPicks;

/** The session `value` names on the task: previous, the last stage run's; an id, one that opens in its worktree; new or a gone id, none. */
export function sessionOf(value: string, task: Task, state: State): Session | undefined {
  if (value === NEW_SESSION) return undefined;
  return value === PREVIOUS_SESSION ? previousSession(task, state) : worktreeSessions(task, state).find((s) => s.id === value);
}

// Whether `agent` can resume what `value` names (#925): new always; a session only under the agent that recorded it
const canResume = (value: string, agent: AgentId, task: Task | undefined, state: State): boolean =>
  value === NEW_SESSION || (task !== undefined && sessionOf(value, task, state)?.agent === agent);

/** What the stage would run with (#290): its agent, the model left to runModel's chain, the previous stage's session when the stage continues
 * and its agent can resume it, no specialized agent, no arguments. */
export function initialPicks(task: Task | undefined, state: State, defaultAgent: AgentId): RunPicks {
  const stage = task === undefined ? undefined : stageOf(state.stages, task.stage);
  const agent = stage?.agent ?? defaultAgent;
  const isResumed = stage?.session === 'continue' && canResume(PREVIOUS_SESSION, agent, task, state);
  return { agent, model: '', session: isResumed ? PREVIOUS_SESSION : NEW_SESSION, specializedAgent: '', args: '' };
}

/** `picks` with `change` (#290): another agent's model means nothing to the new one, so an explicit pick goes back to the chain (#257), and a
 * session it cannot resume goes back to new. */
export function nextPicks(picks: RunPicks, change: Partial<RunPicks>, task: Task | undefined, state: State): RunPicks {
  const next = { ...picks, ...change };
  if (change.agent === undefined || change.agent === picks.agent) return next;
  return { ...next, model: '', session: canResume(next.session, next.agent, task, state) ? next.session : NEW_SESSION };
}

export const isChanged = (picks: RunPicks, initial: RunPicks): boolean => (Object.keys(initial) as RunField[]).some((f) => picks[f] !== initial[f]);

/** What a start posts for the picks (#290): only what differs from the stage, since absent is the stage's own. The agent once changed; the
 * session once it or the agent changed (the stage's policy reads its own agent); a model, specialized agent and args only once picked
 * explicitly. An untouched dialog posts today's body. */
export function startBody(picks: RunPicks, initial: RunPicks): Record<string, unknown> {
  const isAgentChanged = picks.agent !== initial.agent;
  return {
    ...(isAgentChanged ? { agent: picks.agent } : {}),
    ...(isAgentChanged || picks.session !== initial.session ? { session: picks.session } : {}),
    ...launchOf(picks),
  };
}

/** What a free open posts (#257, #290): the agent, then a resume's id, which runs with its own record's picks, or a new session's explicit picks. */
export function openBody(picks: RunPicks, task: Task, state: State): Record<string, unknown> {
  const resumed = sessionOf(picks.session, task, state);
  return resumed === undefined ? { kind: picks.agent, ...launchOf(picks) } : { kind: picks.agent, continueId: resumed.id };
}

/** The picks a free resume runs with (#257): its record's, which the fields show disabled; undefined for a new session. */
export function resumedLaunch(picks: RunPicks, task: Task, state: State): LaunchPick | undefined {
  const resumed = sessionOf(picks.session, task, state);
  return resumed === undefined ? undefined : (resumed.launch ?? {});
}

/** The Start dialog's run fields (#290), per picked task: the stage's values until the user changes one, kept while that task stays picked;
 * restore goes back to the stage's. stageModel: what a stage run's '' model resolves to (runModel), the hint the model field and the summary
 * show. isCustomizing: the personalizar block is open. */
export function useRunPick(state: State, task: Task | undefined, defaultAgent: AgentId) {
  const initial = initialPicks(task, state, defaultAgent);
  const [edited, setEdited] = useState<{ itemId: string; picks: RunPicks }>();
  const [isCustomizing, setCustomizing] = useState(false);
  const itemId = task?.item.itemId;
  const picks = edited !== undefined && edited.itemId === itemId ? edited.picks : initial;
  const stage = task === undefined ? undefined : stageOf(state.stages, task.stage);
  const stageModel = stage === undefined ? undefined : runModel(undefined, stage, picks.agent, defaultAgent);
  const set = (change: Partial<RunPicks>): void => {
    if (itemId !== undefined) setEdited({ itemId, picks: nextPicks(picks, change, task, state) });
  };
  return { picks, initial, stageModel, set, restore: (): void => setEdited(undefined), isCustomizing, setCustomizing };
}

export type RunPickState = ReturnType<typeof useRunPick>;
