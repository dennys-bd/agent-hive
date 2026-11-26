import type { Machine, MachineFor } from './machine.js';
import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { heldSession, taskOfWorker } from './activities.js';
import { requireWorkspace, taskWorkspace, workspaceByName } from './config.js';
import { writeRunFiles } from './spawn.js';
import { type AccountEnvAnswer, ACCOUNT_UNAVAILABLE, seamRefusalLine, type AccountSeam, type RunAccountsStore } from './account-env.js';
import { capturedReply, isEnvLine, refusedReply, resumeOf, type ShimResume, shimPath } from './shim.js';
import { AGENTS, knownAgent, ranAgent } from './agents.js';
import { MCP_SECRET_ENV } from './agents/codex.js';
import { runners } from './agents/registry.js';
import type { AgentRun, RunMcpServer } from './agents/runner.js';
import { activityDir, sourceSide } from './copy-sides.js';
import { workspaceProtocolPaths } from './hooks-settings.js';
import { readProtocolText, writeMcpConfig } from './home-hooks.js';
import { isUuid } from './orchestrator.js';
import type { PluginRender } from './plugin-render.js';
import type { Runtime } from './server.js';
import { errorMessage } from './server-review.js';
import { exitEvent } from './server-exit.js';
import { taskProtocol } from './server-spawn.js';
import { answerOpen, type Refusal, refuse } from './server-tasks.js';
import { inFlow } from './tasks.js';
import { strayAgents } from './shell-procs.js';
import { capturedCwd, liveShell } from './terminal-runs.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';
import { AGENT_IDS, type Activity, type AgentId, type Config, type Effect, type HiveEvent, type SessionRef, type State, type Task, type Worker, type Workspace } from './types.js';

// The routes of one kept terminal (#696): wake and forget, from its sidebar line, its sleeping tab and its activity's pick; and the agent
// shim's register, which captures an agent typed in it as a free session.

export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const UNKNOWN_TERMINAL_MESSAGE = 'terminal desconhecido';
const NOT_ASLEEP_MESSAGE = 'o terminal não está dormindo';
const STILL_ENDING_MESSAGE = 'o terminal ainda está terminando';
const NO_CAPTURE_MESSAGE = 'nenhum terminal vivo com esse id';
const HTTP_SERVER_ERROR = 500;
const HTTP_UNPROCESSABLE = 422; // not 409: the page reads a 409 on a wake as a harmless race and shows nothing, and this one has a reason to show
const SPLIT_REPLY_MESSAGE = 'um argumento ou uma variável do agente não cabe na resposta';
const RESUME_HELD_MESSAGE = 'essa sessão já roda em outra execução';
const OTHER_CHECKOUT_MESSAGE = 'essa conversa é de outro checkout';
const HTTP_BAD_REQUEST = 400;
const UNKNOWN_AGENT_MESSAGE = `agent precisa ser um destes agentes: ${AGENT_IDS.join(', ')}`; // #932: the shim names its own
const NO_WAKE_MESSAGE = 'o terminal não pode acordar: a atividade, a worktree ou o workspace não existe mais';

export interface TerminalRouteDeps {
  machineFor: MachineFor; // #158: the activity's machine; #161 reads it
  requireLive(res: Response): { state: State; runtime: Runtime } | undefined;
  live(): { state: State; runtime: Runtime } | undefined; // the same, read with no answer written: after a dispatch, whose reply is the route's own
  dispatch(event: HiveEvent, size?: TerminalSize): Promise<Effect[]>; // #808: size, the page's grid, for a wake's spawn
  running(ptyId: string): boolean; // the pool's has: a terminal asleep in the state whose pty has not exited yet
  started(ptyId: string): Promise<void>; // the pool's: what a wake awaits before it answers the run, as /open does (#249)
  secret: string; // this boot's (#467): the captured session's MCP config carries it, as a free session's does
  home: string; // where the shim is, which the agents walk skips
  recordStart(runtime: Runtime, activity: Activity, task: Task, stage: string): Promise<void>; // #812: the spawner's, for a captured session
  lspDir(workspace: string): string | undefined; // #803: the workspace's language-server plugin, which a terminal's agent loads as any run does
  plugin: Pick<PluginRender, 'dir' | 'ready'>; // #316: the workspace's plugin folder, which a terminal's agent loads as any run does
  externalMcp(config: Config, workspace: string): Promise<readonly RunMcpServer[]>; // #333: the spawner's, for a captured session
  dropRunTmp(runId: string): Promise<void>; // #876: a captured run's tmp dir (its runFiles), which no pty of the Hive's removes; never rejects
  accountEnv: AccountSeam; runAccounts: Pick<RunAccountsStore, 'set'>; // #953
}

export const terminalParam = (req: Request): string => String(req.params.id);

/** The machine a terminal's pty is on (#159): its activity's; a workspace's shell, on no task's activity, is on its workspace's, the local one. */
export function terminalMachine(state: State | undefined, machineFor: MachineFor, terminalId: string): Machine {
  const terminal = state?.terminals.find((t) => t.terminalId === terminalId);
  return machineFor(state?.activities.find((a) => a.id === terminal?.activityId) ?? {});
}

// A terminal id is a randomUUID (state-store keeps no other shape): anything else is unknown before a lookup, a dispatch or a pid read
function uuidParam(req: Request, res: Response, next: NextFunction): void {
  if (isUuid(req.params.id)) next();
  else refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TERMINAL_MESSAGE });
}

// Why a route on a sleeping terminal refuses: unknown (a command's run is none of these routes'), or awake
function notAsleep(state: State, terminalId: string): Refusal | undefined {
  const terminal = state.terminals.find((t) => t.terminalId === terminalId && t.command === undefined);
  if (!terminal) return { status: HTTP_NOT_FOUND, message: UNKNOWN_TERMINAL_MESSAGE };
  return terminal.asleep ? undefined : { status: HTTP_CONFLICT, message: NOT_ASLEEP_MESSAGE };
}

// Wake (#696): answered like /open, so the page attaches the run at once
function registerWake(app: Express, deps: TerminalRouteDeps): void {
  app.post('/terminals/:id/wake', uuidParam, async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const terminalId = terminalParam(req);
    const refusal = notAsleep(current.state, terminalId);
    if (refusal) return refuse(res, refusal);
    // Asleep in the state as soon as its cwd is read, but its pty dies after: a spawn in its id before that exit would race it (#696)
    if (deps.running(terminalId)) return refuse(res, { status: HTTP_CONFLICT, message: STILL_ENDING_MESSAGE });
    const effects = await deps.dispatch({ type: 'wakeTerminal', terminalId }, sizeIn(req.body));
    if (!effects.some((e) => e.type === 'spawnTerminal')) return refuse(res, { status: HTTP_UNPROCESSABLE, message: NO_WAKE_MESSAGE });
    await answerOpen(deps, effects, res);
  });
}

// Forget (#696): a sleeping terminal's line menu; the reducer drops it and the server its files
function registerForget(app: Express, deps: TerminalRouteDeps): void {
  app.post('/terminals/:id/forget', uuidParam, async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const terminalId = terminalParam(req);
    const refusal = notAsleep(current.state, terminalId);
    if (refusal) return refuse(res, refusal);
    await deps.dispatch({ type: 'forgetTerminal', terminalId });
    res.json({ ok: true });
  });
}

// #1049: the workspace whose origin picks the capture's GitLab account, read before the seam as captureRun reads it: its task's, else its
// activity's. One no longer in the config is none here; captureRun refuses it right after
function captureWorkspace(live: { state: State; runtime: Runtime }, worker: Worker): Workspace | undefined {
  const { state, runtime: { config } } = live;
  const activity = state.activities.find((a) => a.id === worker.activityId);
  const task = activity?.kind === 'task' ? taskOfWorker(state, worker) : undefined;
  return task === undefined ? workspaceByName(config, activity?.workspace) : taskWorkspace(config, task);
}

// #924, #932: the capture through its worker's runner: the Hive's flags, the agent's own args, the session id the route drew (none for an agent
// that picks its own), the folder the shim ran in, the Hive's tools and its protocol as a path and as text (Codex's): a task's session protocol,
// or on a local activity its workspace's local one (#256)
async function captureRun(deps: TerminalRouteDeps, live: { state: State; runtime: Runtime }, worker: Worker, o: { runId: string; cwd: string; sessionId?: string }): Promise<AgentRun> {
  const { state, runtime } = live;
  const agent = ranAgent(worker);
  const activity = state.activities.find((a) => a.id === worker.activityId);
  const onTask = activity?.kind === 'task'; // a task's session protocol on a task's activity; the workspace's local one elsewhere (#256)
  const task = onTask ? taskOfWorker(state, worker) : undefined; // #797: its workspace's protocol, the memory under it
  // #812: before the shim starts the agent, as an open's spawn does; never in a checkout task's own checkout (#444)
  if (task && inFlow(task) && activity && !activity.local) await deps.recordStart(runtime, activity, task, task.stage);
  // #803: a captured agent is a free session of the terminal's activity, so it loads its workspace's language servers, a local activity's too.
  // #317: and its workspace's plugin folder: a task whose workspace left the config, or a workspace with no folder, refuses the capture (throws)
  const workspace = task === undefined ? activity?.workspace : requireWorkspace(runtime.config, task).name;
  if (workspace === undefined) throw new Error(NO_CAPTURE_MESSAGE);
  const external = await deps.externalMcp(runtime.config, workspace); // #333
  const mcpPath = await writeMcpConfig(runtime.promptsDir, o.runId, runners[agent].mcpConfig({ port: runtime.port, ptyId: o.runId, secret: deps.secret, withHive: true, external })); // #256: a local terminal's agent too
  await deps.plugin.ready(); // #316: a render queued by a save or the plugins store lands before this run reads its folder
  const protocolPath = onTask ? (task ? taskProtocol(deps.home, runtime, task).session : runtime.protocol.session) : workspaceProtocolPaths(deps.home, workspace).local;
  return {
    ptyId: o.runId, cwd: o.cwd, port: runtime.port, withHive: true, external, mcpPath, hooksPath: runtime.hooksPath, pluginDir: deps.plugin.dir(workspace),
    lspPluginDir: deps.lspDir(workspace),
    protocolPath, protocolText: await readProtocolText(protocolPath),
    extraArgs: runtime.config.agentArgs[agent],
    ...(o.sessionId === undefined ? {} : { session: { id: o.sessionId, resume: false } }),
  };
}

type CaptureResume = NonNullable<Extract<HiveEvent, { type: 'captureSession' }>['resume']>;

// #347, #800: the args of a form, one `arg` field each (a terminal session's, the command shim's acquire): a single one arrives as a string,
// several as an array; anything else is none
export const formArgs = (value: unknown): string[] =>
  (typeof value === 'string' ? [value] : Array.isArray(value) && value.every((arg): arg is string => typeof arg === 'string') ? value : []);

// Whether a held session's folder is the terminal's activity's (#347): Codex would run a rollout of another checkout from here
function sameFolder(state: State, config: Config, terminalId: string, ref: SessionRef, machineFor: MachineFor): boolean {
  const terminal = state.terminals.find((t) => t.terminalId === terminalId);
  const source = sourceSide(state, config, ref, machineFor);
  return terminal !== undefined && !('status' in source) && source.side.cwd === activityDir(state, config, terminal.activityId, machineFor);
}

// #347: what a resume registers as. A live run already on its id refuses it: two workers on one session id would break every hook's routing. A
// held id runs in the activity holding it, unless the agent resumes from any folder (Codex) and that activity's folder is not this terminal's.
// An id no activity holds, or none yet (-c, the picker, Codex's --last), is named by the run's first SessionStart. Undefined: a new conversation
function resumeTarget(live: { state: State; runtime: Runtime }, terminalId: string, agent: AgentId, read: ShimResume, machineFor: MachineFor): CaptureResume | Refusal | undefined {
  if (read.kind === 'new') return undefined;
  const { sessionId } = read;
  if (sessionId === undefined) return {};
  if (live.state.workers.some((w) => w.status !== 'empty' && w.sessionId === sessionId)) return { status: HTTP_CONFLICT, message: RESUME_HELD_MESSAGE };
  const held = heldSession(live.state, sessionId);
  if (!held) return {};
  const ref = { activityId: held.record.id, sessionId };
  if (AGENTS[agent].resumesAnyFolder && !sameFolder(live.state, live.runtime.config, terminalId, ref, machineFor)) return { status: HTTP_CONFLICT, message: OTHER_CHECKOUT_MESSAGE };
  return ref;
}

// #876: the run's env as a spawn applies it (runEnv), for the shim to export. Never the Hive's own MCP secret, which the shim's codex case
// reads from the secret file; an external server's header token (Codex's HIVE_MCP_TOKEN_<i>) does ride this loopback, secret-gated reply, as
// the spec decides, since the run needs it and the reply is never logged
const replyEnv = (deps: TerminalRouteDeps, agent: AgentId, run: AgentRun): [string, string][] =>
  Object.entries(runners[agent].runEnv({ port: run.port, ptyId: run.ptyId, secret: deps.secret, withHive: run.withHive, external: run.external }, run))
    .filter(([name]) => name !== MCP_SECRET_ENV);

// The shim's register (#696): a free session of the terminal's activity, answered as the run id, the count of its env lines, those `NAME=value`
// lines, then the argv the agent gets before the user's own, one per line, which the shim reads as data (capturedReply); an arg holding a line
// break refuses the register. Under /hooks/:
// secret-authenticated as a hook is, with no UI header (server.ts' gate). Its body is a form (#932): the agent the shim wraps, its $PWD and
// each of the user's args (#347).
function registerCapture(app: Express, deps: TerminalRouteDeps): void {
  app.post('/hooks/terminals/:id/session', uuidParam, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const form = (req.body ?? {}) as Record<string, unknown>; // no body: Express 5 leaves it undefined
    const agent = knownAgent(form.agent);
    if (agent === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: UNKNOWN_AGENT_MESSAGE });
    const terminalId = terminalParam(req);
    const resume = resumeTarget(current, terminalId, agent, resumeOf(agent, formArgs(form.arg)), deps.machineFor); // #347
    if (resume !== undefined && 'status' in resume) return refuse(res, resume);
    const runId = randomUUID();
    // #932: Codex picks its own, recorded at its SessionStart. #347: a resume runs the user's own conversation, under no id of the Hive's
    const sessionId = resume === undefined && AGENTS[agent].canChooseSessionId ? randomUUID() : undefined;
    await deps.dispatch({ type: 'captureSession', terminalId, runId, agent, ...(sessionId === undefined ? {} : { sessionId }), ...(resume === undefined ? {} : { resume }) });
    const after = deps.live(); // never requireLive again: on a Hive gone meanwhile it would answer, and the refusal below a second time
    const worker = after?.state.workers.find((w) => w.runId === runId);
    if (!after || !worker) return refuse(res, { status: HTTP_CONFLICT, message: NO_CAPTURE_MESSAGE });
    // A refusal ends the run it just made: the shim runs the agent unregistered, and no run is left behind
    const unregister = async (answer: () => void): Promise<void> => {
      try {
        await deps.dispatch(await exitEvent(deps.live(), runId, deps.machineFor)); // #586: one builder for every exit; a captured run is never flagged
      } catch {
        // Not rethrown: the shim must be answered, or its curl fails and it runs the agent unregistered on the machine's login (#953)
      } finally {
        await deps.dropRunTmp(runId); // #876: whatever the write below got to, even when the exit could not be dispatched
      }
      answer();
    };
    const refused = (line: string) => (): void => void res.type('text/plain').send(refusedReply(line));
    const failed = (message: string) => (): void => refuse(res, { status: HTTP_SERVER_ERROR, message });
    // #927, #932: Codex trusts the run's folder up front: the posted one after a cd inside the terminal's folder, never one outside it
    const terminal = after.state.terminals.find((x) => x.terminalId === terminalId);
    const cwd = capturedCwd(form.cwd, terminal?.cwd) ?? terminal?.cwd ?? '';
    let account: AccountEnvAnswer;
    try {
      const workspace = captureWorkspace(after, worker);
      account = await deps.accountEnv({ agent, ...(workspace === undefined ? {} : { workspace }) }); // #953: before anything of the run's is recorded or written
      deps.runAccounts.set(runId, account.accounts);
    } catch (err) {
      return unregister(refused(seamRefusalLine(err)));
    }
    let run: AgentRun;
    try {
      run = await captureRun(deps, after, worker, { runId, cwd, sessionId });
      await writeRunFiles(runners[agent].runFiles(run)); // #876: Copilot's instructions, under runTmpDir(runId), before the shim starts it
    } catch (err) {
      return unregister(failed(errorMessage(err)));
    }
    // #953: the account env first, so a runEnv line of the same name, exported after it, wins
    const reply = capturedReply(runId, [...Object.entries(account.env), ...replyEnv(deps, agent, run)], runners[agent].launch(run).flat());
    // An account env the reply cannot carry (a bad name, a line break) is the account's refusal, not a 500: the shim would run unregistered on it
    if (reply === undefined) return unregister(Object.entries(account.env).every(isEnvLine) ? failed(SPLIT_REPLY_MESSAGE) : refused(ACCOUNT_UNAVAILABLE));
    res.type('text/plain').send(reply);
  });
}

// The agents a live terminal runs that the shim missed (#696): what the confirms before its sleep warn about
function registerAgents(app: Express, deps: TerminalRouteDeps): void {
  app.get('/terminals/:id/agents', uuidParam, async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const terminalId = terminalParam(req);
    if (!liveShell(current.state, terminalId)) return refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_TERMINAL_MESSAGE });
    const captured = current.state.workers.flatMap((w) => (w.terminalId === terminalId && w.sessionId !== undefined ? [w.sessionId] : []));
    const shims = AGENT_IDS.map((id) => shimPath(deps.home, AGENTS[id])); // #932: every agent's shim, first on the terminal's PATH
    res.json({ agents: await strayAgents(terminalMachine(current.state, deps.machineFor, terminalId), terminalId, { captured, shims }) });
  });
}

/** The kept terminals' routes (#696), behind the same host, secret and UI-header gate as every dashboard write; the register sits under
 * /hooks/, behind the secret only, as every hook does. */
export function registerTerminalRoutes(app: Express, deps: TerminalRouteDeps): void {
  registerWake(app, deps);
  registerForget(app, deps);
  registerCapture(app, deps);
  registerAgents(app, deps);
}
