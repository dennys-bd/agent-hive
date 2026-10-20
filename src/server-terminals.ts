import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { taskOfWorker } from './activities.js';
import { requireWorkspace } from './config.js';
import { capturedCwd, capturedReply, shimPath } from './shim.js';
import { AGENTS, knownAgent, ranAgent } from './agents.js';
import { runners } from './agents/registry.js';
import type { AgentRun, RunMcpServer } from './agents/runner.js';
import { writeMcpConfig } from './hooks-settings.js';
import { isUuid } from './orchestrator.js';
import type { PluginRender } from './plugin-render.js';
import type { Runtime } from './server.js';
import { errorMessage } from './server-review.js';
import { taskProtocol } from './server-spawn.js';
import { answerOpen, type Refusal, refuse } from './server-tasks.js';
import { strayAgents } from './shell-procs.js';
import { liveShell } from './terminal-runs.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';
import { AGENT_IDS, type Activity, type Config, type Effect, type Exec, type HiveEvent, type State, type Task, type Worker } from './types.js';

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
const SPLIT_ARG_MESSAGE = 'um argumento do claude tem quebra de linha';
const HTTP_BAD_REQUEST = 400;
const UNKNOWN_AGENT_MESSAGE = `agent precisa ser um destes agentes: ${AGENT_IDS.join(', ')}`; // #932: the shim names its own
const NO_WAKE_MESSAGE = 'o terminal não pode acordar: a atividade, a worktree ou o workspace não existe mais';

export interface TerminalRouteDeps {
  requireLive(res: Response): { state: State; runtime: Runtime } | undefined;
  live(): { state: State; runtime: Runtime } | undefined; // the same, read with no answer written: after a dispatch, whose reply is the route's own
  dispatch(event: HiveEvent, size?: TerminalSize): Promise<Effect[]>; // #808: size, the page's grid, for a wake's spawn
  running(ptyId: string): boolean; // the pool's has: a terminal asleep in the state whose pty has not exited yet
  started(ptyId: string): Promise<void>; // the pool's: what a wake awaits before it answers the run, as /open does (#249)
  secret: string; // this boot's (#467): the captured session's MCP config carries it, as a free session's does
  exec: Exec; // pgrep for the agents under a terminal's shell; tests inject a fake
  pid(ptyId: string): number | undefined; // the pty host's
  home: string; // where the shim is, which the agents walk skips
  recordStart(runtime: Runtime, activity: Activity, task: Task, stage: string): Promise<void>; // #812: the spawner's, for a captured session
  lspDir(workspace: string): string | undefined; // #803: the workspace's language-server plugin, which a terminal's agent loads as any run does
  plugin: Pick<PluginRender, 'dir' | 'ready'>; // #316: the workspace's plugin folder, which a terminal's agent loads as any run does
  externalMcp(config: Config, workspace: string): Promise<readonly RunMcpServer[]>; // #333: the spawner's, for a captured session
}

export const terminalParam = (req: Request): string => String(req.params.id);

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

// #924, #932: the capture through its worker's runner: the Hive's flags, the agent's own args, the session id the route drew (none for an agent
// that picks its own), the folder the shim ran in, and on a task the Hive's tools and session protocol, as a path and as text (Codex's)
async function captureRun(deps: TerminalRouteDeps, live: { state: State; runtime: Runtime }, worker: Worker, o: { runId: string; cwd: string; sessionId?: string }): Promise<AgentRun> {
  const { state, runtime } = live;
  const agent = ranAgent(worker);
  const activity = state.activities.find((a) => a.id === worker.activityId);
  const onTask = activity?.kind === 'task'; // the Hive's tools and protocol on a task's only
  const task = onTask ? taskOfWorker(state, worker) : undefined; // #797: its workspace's protocol, the memory under it
  // #812: before the shim starts the agent, as an open's spawn does; never in a checkout task's own checkout (#444)
  if (task && activity && !activity.local) await deps.recordStart(runtime, activity, task, task.stage);
  // #803: a captured agent is a free session of the terminal's activity, so it loads its workspace's language servers, a local activity's too.
  // #317: and its workspace's plugin folder: a task whose workspace left the config, or a workspace with no folder, refuses the capture (throws)
  const workspace = task === undefined ? activity?.workspace : requireWorkspace(runtime.config, task).name;
  if (workspace === undefined) throw new Error(NO_CAPTURE_MESSAGE);
  const external = await deps.externalMcp(runtime.config, workspace); // #333
  const mcpPath = await writeMcpConfig(runtime.promptsDir, o.runId, runners[agent].mcpConfig({ port: runtime.port, ptyId: o.runId, secret: deps.secret, withHive: onTask, external }));
  await deps.plugin.ready(); // #316: a render queued by a save or the plugins store lands before this run reads its folder
  const protocolPath = onTask ? (task ? taskProtocol(deps.home, runtime, task).session : runtime.protocol.session) : undefined;
  return {
    ptyId: o.runId, cwd: o.cwd, port: runtime.port, withHive: onTask, external, mcpPath, hooksPath: runtime.hooksPath, pluginDir: deps.plugin.dir(workspace),
    lspPluginDir: deps.lspDir(workspace),
    ...(protocolPath === undefined ? {} : { protocolPath, protocolText: await readFile(protocolPath, 'utf8') }),
    extraArgs: runtime.config.agentArgs[agent],
    ...(o.sessionId === undefined ? {} : { session: { id: o.sessionId, resume: false } }),
  };
}

// The shim's register (#696): a free session of the terminal's activity, answered as the run id then the argv the agent gets before the user's
// own, one arg per line, which the shim reads as data (capturedReply); an arg holding a line break refuses the register. Under /hooks/:
// secret-authenticated as a hook is, with no UI header (server.ts' gate). Its body is a form (#932): the agent the shim wraps and its $PWD.
function registerCapture(app: Express, deps: TerminalRouteDeps): void {
  app.post('/hooks/terminals/:id/session', uuidParam, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    if (!deps.requireLive(res)) return;
    const form = (req.body ?? {}) as Record<string, unknown>; // no body: Express 5 leaves it undefined
    const agent = knownAgent(form.agent);
    if (agent === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: UNKNOWN_AGENT_MESSAGE });
    const runId = randomUUID();
    const sessionId = AGENTS[agent].canChooseSessionId ? randomUUID() : undefined; // #932: Codex picks its own, recorded at its SessionStart
    await deps.dispatch({ type: 'captureSession', terminalId: terminalParam(req), runId, agent, ...(sessionId === undefined ? {} : { sessionId }) });
    const after = deps.live(); // never requireLive again: on a Hive gone meanwhile it would answer, and the refusal below a second time
    const worker = after?.state.workers.find((w) => w.runId === runId);
    if (!after || !worker) return refuse(res, { status: HTTP_CONFLICT, message: NO_CAPTURE_MESSAGE });
    // A refusal ends the run it just made: the shim runs the agent unregistered, and no run is left behind
    const unregister = async (message: string): Promise<void> => {
      await deps.dispatch({ type: 'exit', ptyId: runId });
      refuse(res, { status: HTTP_SERVER_ERROR, message });
    };
    // #927, #932: Codex trusts the run's folder up front: the posted one after a cd inside the terminal's folder, never one outside it
    const terminal = after.state.terminals.find((x) => x.terminalId === terminalParam(req));
    const cwd = capturedCwd(form.cwd, terminal?.cwd) ?? terminal?.cwd ?? '';
    let run: AgentRun;
    try {
      run = await captureRun(deps, after, worker, { runId, cwd, sessionId });
    } catch (err) {
      return unregister(errorMessage(err));
    }
    const reply = capturedReply(runId, runners[agent].launch(run).flat());
    if (reply === undefined) return unregister(SPLIT_ARG_MESSAGE);
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
    res.json({ agents: await strayAgents(deps.pid(terminalId), { captured, shims }, deps.exec) });
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
