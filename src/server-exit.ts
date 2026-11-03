import { realpath } from 'node:fs/promises';
import { activityOfWorker, taskOfWorker } from './activities.js';
import { ranAgent } from './agents.js';
import { taskWorkspace } from './config.js';
import { isUuid } from './uuid.js';
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
  if (id === undefined || !isUuid(id) || activity?.kind !== 'task' || task === undefined) return undefined;
  const workspace = taskWorkspace(config, task);
  return workspace && { cwd: taskDir(workspace.path, activity), id, agent: ranAgent(worker) };
}

// The cwd as the Hive spelled it and as the agent may see it: a workspace reached through a symbolic link names another transcript dir once
// resolved, and checking only one would forget a session whose transcript sits in the other
export async function cwdsOf(cwd: string): Promise<string[]> {
  const real = await realpath(cwd).catch(() => cwd); // a cwd gone from the disk: its own spelling is all there is
  return real === cwd ? [cwd] : [cwd, real];
}

/** The exit of run `ptyId`, flagged `noTranscript` when the task's session it holds has no transcript where its agent's resume would look
 * (#586). A check that throws counts as found, and so does any failure here: a check that cannot run never forgets a session, and never
 * loses the exit either. */
export async function exitEvent(live: Live | undefined, ptyId: string, env: NodeJS.ProcessEnv = process.env): Promise<ExitEvent> {
  const plain: ExitEvent = { type: 'exit', ptyId };
  try {
    const run = live && runToCheck(live.state, live.runtime.config, ptyId);
    if (run === undefined) return plain;
    const found = await findTranscript(await cwdsOf(run.cwd), run.id, run.agent, env);
    return found === undefined ? { ...plain, noTranscript: true } : plain;
  } catch {
    return plain;
  }
}
