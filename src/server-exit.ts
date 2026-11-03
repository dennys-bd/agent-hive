import { activityOfWorker, taskOfWorker } from './activities.js';
import { ranAgent } from './agents.js';
import { taskWorkspace } from './config.js';
import { runSessionId } from './record-kit.js';
import type { Runtime } from './server.js';
import { findTranscript } from './transcript.js';
import type { AgentId, Config, HiveEvent, State } from './types.js';
import { taskDir } from './worktree.js';

// Every exit event the server dispatches (#586): one place builds it, so no exit path skips the transcript check.

type ExitEvent = Extract<HiveEvent, { type: 'exit' }>;
type Live = { state: State; runtime: Pick<Runtime, 'config'> };

// The run to check, in the cwd `spawn` gave it: its worktree, or the user's checkout for a checkout task (taskDir). Nothing for a run with no
// check to make: a terminal, a captured agent (its cwd is the user's, wherever they typed it), a local run (forgetUnopenedLocal's, #587), a run
// with no session id (Codex before its SessionStart never recorded one), a task whose workspace left the config
function runToCheck(state: State, config: Pick<Config, 'comb'>, ptyId: string): { cwd: string; id: string; agent: AgentId } | undefined {
  const worker = state.workers.find((w) => w.runId === ptyId && w.status !== 'empty');
  if (worker === undefined || worker.terminalId !== undefined) return undefined;
  const id = runSessionId(state, worker);
  const activity = activityOfWorker(state, worker);
  const task = taskOfWorker(state, worker);
  if (id === undefined || activity?.kind !== 'task' || task === undefined) return undefined;
  const workspace = taskWorkspace(config, task);
  return workspace && { cwd: taskDir(workspace.path, activity), id, agent: ranAgent(worker) };
}

/** The exit of run `ptyId`, flagged `noTranscript` when the task's session it holds has no transcript where its agent's resume would look
 * (#586). A check that throws counts as found: a check that cannot run never forgets a session. */
export async function exitEvent(live: Live | undefined, ptyId: string, env: NodeJS.ProcessEnv = process.env): Promise<ExitEvent> {
  const plain: ExitEvent = { type: 'exit', ptyId };
  const run = live && runToCheck(live.state, live.runtime.config, ptyId);
  if (run === undefined) return plain;
  const found = await findTranscript([run.cwd], run.id, run.agent, env).catch(() => 'unread');
  return found === undefined ? { ...plain, noTranscript: true } : plain;
}
