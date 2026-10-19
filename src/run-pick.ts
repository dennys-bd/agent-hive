// A manual start's run picks (#290): what POST /tasks/:id/start may ask its stage run to launch with, checked against the task, its stage, its
// start mode and this machine. Out of server-tasks.ts, which is over its size.
import { activityOf } from './activities.js';
import { isAvailable, knownAgent, stageAgentIn } from './agents.js';
import { askedLaunch } from './launch-options.js';
import { isRecord } from './rate-limits.js';
import type { Refusal } from './server-tasks.js';
import { startMode, startsFresh } from './task-runs.js';
import { previousSession, stageOf, worktreeSessions } from './tasks.js';
import type { AgentAvailability, AgentId, Language, RunPick, State, Task } from './types.js';
import { MESSAGES } from './ui/i18n.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const PICK_FIELDS = ['agent', 'session', 'model', 'specializedAgent', 'args'] as const;

type RunPickRefusal = 'agent' | 'session' | 'action' | 'handover' | 'continue';
const refusal = (key: RunPickRefusal, language: Language, status = HTTP_BAD_REQUEST): Refusal => ({ status, message: MESSAGES[language][`runPick.refused.${key}`] });

// The body's session as the run takes it: new is null; previous, the last stage run's session; an id, one of the task's sessions in its
// worktree. Either must be one `agent` recorded (#925). Undefined when it names nothing the agent can resume
function resumeOf(session: unknown, state: State, task: Task, agent: AgentId): Pick<RunPick, 'resume'> | undefined {
  if (session === undefined) return {};
  if (session === 'new') return { resume: null };
  const found = session === 'previous' ? previousSession(task, state) : worktreeSessions(task, state).find((s) => s.id === session);
  return found?.agent === agent ? { resume: found.id } : undefined;
}

// Why the task's run takes no picks, or undefined: a stage that runs no agent, a handover that decides the run (#134), a run that is not a start
function pickRefusal(state: State, task: Task, language: Language): Refusal | undefined {
  const stage = stageOf(state.stages, task.stage);
  if (stage === undefined || stage.action !== undefined) return refusal('action', language);
  if (activityOf(state, task.item.itemId)?.handover !== undefined) return refusal('handover', language, HTTP_CONFLICT);
  return startsFresh(startMode(task, state)) ? undefined : refusal('continue', language, HTTP_CONFLICT);
}

/** The run picks a start's body asks for (#290): none asked is none ({}), so today's start is unchanged; else the agent (one this machine has),
 * the session (new, previous or one of the task's, recorded by that agent) and #257's launch, checked with no continueId: a stage resume runs
 * the stage's prompt with the new picks. Absent fields stay the stage's. A 400 names the field, a 409 the run that takes no picks. `pluginDir`
 * answers the task's workspace's plugin folder, whose agents a specialized agent must be one of (#316); it is read only when one is named (#317). */
export function parseRunPick(body: unknown, state: State, task: Task, agents: readonly AgentAvailability[], language: Language, pluginDir: () => string): { runPick?: RunPick } | Refusal {
  const asked: Record<string, unknown> = isRecord(body) ? body : {};
  if (PICK_FIELDS.every((field) => asked[field] === undefined)) return {};
  const refused = pickRefusal(state, task, language);
  if (refused) return refused;
  const agent = asked.agent === undefined ? stageAgentIn(state, stageOf(state.stages, task.stage) ?? {}) : knownAgent(asked.agent);
  if (agent === undefined || (asked.agent !== undefined && !isAvailable(agent, agents))) return refusal('agent', language);
  const resume = resumeOf(asked.session, state, task, agent);
  if (resume === undefined) return refusal('session', language);
  const launch = askedLaunch(asked, agent, language, pluginDir);
  if ('status' in launch) return launch;
  return { runPick: { ...(asked.agent === undefined ? {} : { agent }), ...resume, ...launch } };
}
