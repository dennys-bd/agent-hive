import { readFile } from 'node:fs/promises';
import { localWorkspaceOf } from './activities.js';
import { runEnv, workspaceBase } from './fork.js';
import { AGENTS, agentOf, agentRefusal, ranAgent, runModel } from './agents.js';
import { runners } from './agents/registry.js';
import type { AgentRun, RunMcpServer } from './agents/runner.js';
import { taskBranch } from './task-runs.js';
import { shownBase } from './setup-rows.js';
import { runTaskSetup } from './task-setup.js';
import { withReused } from './worktree-setup.js';
import { branchFor, LOCAL_SLUG, slugFor } from './tasks.js';
import { taskWorkspace, noWorkspaceReason, workspaceByName, requireWorkspace } from './config.js';
import { commandChannel, type ConsoleStore } from './console.js';
import { feedConsole } from './console-feed.js';
import { workspaceProtocolPaths, writeMcpConfig, type ProtocolPaths } from './hooks-settings.js';
import { launchRun, specializedAgents } from './launch-options.js';
import type { Logger } from './log.js';
import type { PluginRender } from './plugin-render.js';
import type { PtyHost } from './pty-host.js';
import { recordStageStart } from './restart.js';
import { commandIn } from './run-commands.js';
import type { Runtime } from './server.js';
import { renderPrompt, runSession, stackedPrLine, verdictsLine, withHandoff, terminalEnv, writePrompt } from './spawn.js';
import { wakeDir } from './shell-procs.js';
import { ensureTerminalsDir, readScrollback, scrollbackPath } from './terminal-files.js';
import type { Activity, AgentAvailability, AgentId, Config, Task, TaskBase, Stage, Effect, Exec, HiveEvent, PtyLaunch, Terminal, Workspace } from './types.js';
import type { PtyPool } from './ptys.js';
import type { TerminalSize } from './terminal-wire.js';
import { taskDir, ensureCheckout, ensureWorktree } from './worktree.js';
import type { EventLog } from './events.js';

// How a run starts (#283, #251), out of server.ts, which was over 900 lines: the stage run and the user's own session.

type SessionEffect = Extract<Effect, { type: 'spawnSession' }>;

// Where the user's own session runs (#164, #283, #587): a task's worktree or checkout, the main repo for a repo session (#208), a workspace's
// checkout for a local session; in that workspace, whose env the launch resolves (#738, #854). The reason instead when it is gone.
function sessionPlace(config: Runtime['config'], { activity, task, continues, repo }: SessionEffect): { cwd: string; slug: string; workspace: Workspace } | { refusal: string } {
  if (activity.kind === 'local' || task === undefined) {
    const local = workspaceByName(config, activity.workspace);
    return local ? { cwd: local.path, slug: LOCAL_SLUG, workspace: local } : { refusal: `workspace "${activity.workspace}" não existe mais` };
  }
  const resolved = taskWorkspace(config, task);
  if (!resolved) return { refusal: noWorkspaceReason(task) };
  const inRepo = continues && repo === true; // its worktree was removed (#208); the effect says so, since it carries no state (#629)
  return { cwd: inRepo ? resolved.path : taskDir(resolved.path, activity), slug: workSlug(activity, task), workspace: resolved };
}

// A task's activity is born with its slug (#629); the task's own is what it would have been
const workSlug = (activity: Activity, task: Task): string => activity.slug ?? slugFor(task.item);

/** The protocol files a run on `task` is told (#167, #797): its workspace's, with that workspace's memory under the protocol; the global ones
 * for a task whose workspace does not resolve. */
export function taskProtocol(home: string, runtime: Pick<Runtime, 'config' | 'protocol'>, task: Task): ProtocolPaths {
  const workspace = taskWorkspace(runtime.config, task);
  return workspace ? workspaceProtocolPaths(home, workspace.name) : runtime.protocol;
}

export interface SpawnerDeps {
  pool: Pick<PtyPool, 'start'>;
  exec: Exec; // git for the worktree step; tests inject a fake
  log: Pick<Logger, 'info' | 'error'>;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  fail(context: string, err: unknown): Promise<void>;
  isLive(ptyId: string): boolean; // the worker still holds this run (#299): a Stop during the setup freed it
  ptys: Pick<PtyHost, 'has' | 'subscribe' | 'adopt'>; // a run command's output (#353) and a worktree setup's (#351) reach the console through the pty host
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  agents: readonly AgentAvailability[]; // the agent CLIs found on boot (#516): a stage whose agent is missing never reaches its worktree
  secret: string; // this boot's secret (#467): the MCP config's header
  home: string; // #696: where a terminal's history and ring live
  events?: Pick<EventLog, 'write'>; // #742: the worktree setup's worktree.step
  lspDir(workspace: string): string | undefined; // #803: the workspace's language-server plugin as the last write left it; every agent launch loads it
  plugin: Pick<PluginRender, 'dir' | 'ready'>; // #316: the workspace's plugin folder, once the renders queued so far have landed
  externalMcp(config: Config, workspace: string): Promise<readonly RunMcpServer[]>; // #333: the external MCP servers a run of this workspace gets, header values resolved
}

type SpawnEffect = Extract<Effect, { type: 'spawn' }>;

export interface RunSpawner {
  spawn(runtime: Runtime, effect: SpawnEffect, size?: TerminalSize): Promise<void>;
  spawnSession(runtime: Runtime, effect: SessionEffect, size?: TerminalSize): Promise<void>;
  spawnTerminal(runtime: Runtime, effect: Extract<Effect, { type: 'spawnTerminal' }>, size?: TerminalSize): Promise<void>; // #808: size, the page's grid
  recordStart(runtime: Runtime, activity: Activity, task: Task, stage: string): Promise<void>;
  abortSetup(ptyId: string): void; // a Stop's kill during the run's worktree setup (#351): its running step dies, the setup fails with stopped
  prepare(runtime: Runtime, activity: Activity, task: Task, ptyId: string): Promise<string>; // #755: a commands stage's worktree, as a spawn prepares it, its setup included
}

// The stacked-PR line when the popup asked for it (#131): every run of the task is told, its stage prompt or a handover's (#134)
const stackedLine = (base?: TaskBase): string => (base?.tellWorker ? stackedPrLine(base.ref) : '');

/** The rendered stage prompt with the task's result (#99), the verdicts line (#134) and the stacked-PR line when the popup asked for it (#131): what every stage run
 * (spawn or continuation) is told, so the line follows the task through every stage. How to end the stage is not here: it is the
 * protocol, handed to the agent at launch (#167). */
export const stagePrompt = (stage: Stage, task: Task, result?: Record<string, unknown>, base?: TaskBase): string =>
  renderPrompt(stage.prompt ?? '', task.item, result) + verdictsLine(stage) + stackedLine(base);

/** Continue's prompt (#283): the session already holds the stage's prompt and its launch the protocol (#167), so a fixed English line is enough. */
export const CONTINUE_PROMPT = 'You were stopped in the middle of this stage. Continue from where you left off.';

// What a spawn is told (#283, #134): a handover's prompt, composed by the transition, with the stacked-PR line; else the stage's prompt for a
// stage run and Continue's line for a resume.
const ownPrompt = ({ run, stage, activity, task, prompt, result }: SpawnEffect): string => {
  if (prompt !== undefined) return prompt + stackedLine(activity.base);
  return run === 'continue' ? CONTINUE_PROMPT : stagePrompt(stage, task, result, activity.base);
};
// A handoff stage's new session reads the previous stage's handoff first (#692)
const runPrompt = (effect: SpawnEffect): string => withHandoff(ownPrompt(effect), effect.stage, effect.result, effect.session);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// #317: a run's plugin folder, its workspace's rendered one once the renders queued so far have landed (#316); why it cannot start when there
// is none. A raw copy would hold no loadable skill, so there is no fallback
async function pluginFolder(plugin: Pick<PluginRender, 'dir' | 'ready'>, workspace: string): Promise<{ pluginDir: string } | { refusal: string }> {
  await plugin.ready();
  try {
    return { pluginDir: plugin.dir(workspace) };
  } catch (err) {
    return { refusal: errorMessage(err) };
  }
}

// Where the user's own session runs and the plugin folder it loads (#317), or why it cannot start
async function sessionRun(config: Runtime['config'], effect: SessionEffect, plugin: Pick<PluginRender, 'dir' | 'ready'>): Promise<{ cwd: string; slug: string; workspace: Workspace; pluginDir: string } | { refusal: string }> {
  const place = sessionPlace(config, effect);
  if ('refusal' in place) return place;
  const folder = await pluginFolder(plugin, place.workspace.name);
  return 'refusal' in folder ? folder : { ...place, ...folder };
}

// #808: the page's grid on a launch, and no `size: undefined` key when it sent none: the host's fallback applies
const sized = (size?: TerminalSize): Pick<PtyLaunch, 'size'> => (size === undefined ? {} : { size });

// What a stage run launches (#290): the worker's agent, which a manual start may have picked, else the stage's; the picks' specialized agent
// and args after the config's (launchRun), and the model runModel resolves. Or why it cannot start: an agent boot did not find (#516), a
// specialized agent the plugin no longer has (#257)
function stageLaunch({ worker, stage }: SpawnEffect, config: Runtime['config'], agents: readonly AgentAvailability[], pluginDir: string): { agent: AgentId; pluginDir: string; picked: Pick<AgentRun, 'model' | 'extraArgs' | 'specializedAgent'> } | { refusal: string } {
  const agent = worker.agent ?? agentOf(stage, config);
  const refusal = agentRefusal(agent, agents);
  if (refusal !== undefined) return { refusal };
  const picked = launchRun(worker.launch, config.agentArgs[agent], () => specializedAgents(pluginDir)); // #316: the agents its workspace's folder delivers
  if ('refusal' in picked) return picked;
  return { agent, pluginDir, picked: { ...picked, model: runModel(picked.model, stage, agent, config.defaultAgent) } };
}

export function createRunSpawner(deps: SpawnerDeps): RunSpawner {
  const { pool, exec, log, dispatch, fail, isLive, ptys, consoleStore, agents, secret, home, events, lspDir, plugin, externalMcp } = deps;
  const setups = new Map<string, AbortController>(); // the worktree setups in flight, by run (#351): what a Stop's kill aborts
  // What the pool answers for any run: the exit frees it, a kill / focus failure reaches the bar, a start that never happened frees it too.
  const handlers = (ptyId: string, slug: string) => ({
    onExit: (): void => void dispatch({ type: 'exit', ptyId }),
    onError: (message: string): void => void fail(`worker ${slug}`, new Error(message)),
    onSpawnFailed: (message: string): void => void dispatch({ type: 'spawnFailed', ptyId, message }),
  });

  // Where a stage starts (#283): HEAD in the worktree, kept as the stage-start ref and on the activity, which is what Restart resets to. One
  // per stage (#812): a start the stage already has (a free session's, an earlier run's, a feedback or handoff turn's) stays, so Restart undoes
  // all the stage did. A failure only costs the stage its Restart: logged, never a failed run.
  async function recordStart(runtime: Runtime, activity: Activity, task: Task, stage: string): Promise<void> {
    if (activity.stageStart?.stage === stage) return;
    const workspace = taskWorkspace(runtime.config, task);
    if (!workspace) return;
    try {
      const commit = await recordStageStart(workspace.path, taskDir(workspace.path, activity), workSlug(activity, task), exec);
      if (commit) await dispatch({ type: 'stageStarted', activityId: activity.id, stage, commit });
    } catch (err) {
      log.error(`stage start #${task.item.id}: ${errorMessage(err)}`);
    }
  }

  // The run's cwd (#299, #351, #444): the worktree made (or adopted) through runTaskSetup, which marks the task before its git when the
  // worktree still needs its setup, runs that git and the setup in one console run, and hands the setup a controller a Stop's kill reaches. A local task
  // switches the workspace's own checkout instead, already set up by its user: no setup. ensure* refreshes the base first (#119) and answers
  // with the `base: …` line.
  async function prepare(runtime: Runtime, activity: Activity, task: Task, ptyId: string): Promise<string> {
    const { config } = runtime;
    const workspace = requireWorkspace(config, task); // the task's workspace, frozen by the reducer (#179); gone = spawnFailed with the reason
    const branch = taskBranch(activity, branchFor(config, task.item)); // a Restart's -r<n> (#283)
    const base = workspaceBase(config, workspace); // #854: the base remote, the workspace's base branch over the general one, its fork
    let reused: string | undefined; // #267: the branch ensure reused, which a failed setup names
    const ensure = async (git: Exec): Promise<string> => {
      const prepared = activity.local
        ? await ensureCheckout(workspace.path, branch, base, activity.base?.ref, git)
        : await ensureWorktree(workspace.path, workSlug(activity, task), branch, base, activity.base?.ref, git);
      reused = prepared.reused;
      if (prepared.line) log.info(prepared.line);
      if (prepared.sync) await dispatch({ type: 'forkSynced', activityId: activity.id, sync: prepared.sync }); // #854
      return prepared.path;
    };
    if (activity.local) return ensure(exec);
    const controller = new AbortController();
    setups.set(ptyId, controller);
    try {
      return await runTaskSetup({ exec, log, dispatch, ptys, consoleStore, events }, task, activity.id, workspace, taskDir(workspace.path, activity), ensure, { branch, base: shownBase(activity.base?.ref, base), signal: controller.signal }); // #390: the branch row's
    } catch (err) {
      throw withReused(err, reused);
    } finally {
      setups.delete(ptyId);
    }
  }

  // The Hive owns the worktree: created (or adopted) before the worker exists, so the runner only needs a cwd (prepare). A git refusal or a
  // failed setup takes the same path a spawner failure takes: the worker frees and the task keeps the reason until a manual start.
  async function spawn(runtime: Runtime, effect: SpawnEffect, size?: TerminalSize): Promise<void> {
    const { worker: { runId: ptyId }, activity, task, stage, session } = effect;
    if (!ptyId) return;
    const slug = workSlug(activity, task);
    const { config, hooksPath, promptsDir, port } = runtime;
    const placed = taskWorkspace(config, task); // #317: a task whose workspace left the config never starts: it has no folder to load
    const folder = placed ? await pluginFolder(plugin, placed.name) : { refusal: noWorkspaceReason(task) };
    const launch = 'refusal' in folder ? folder : stageLaunch(effect, config, agents, folder.pluginDir); // #516, #290: before prepare, so a run that cannot start leaves no worktree, setup or prompt behind
    if ('refusal' in launch) {
      await dispatch({ type: 'spawnFailed', ptyId, message: launch.refusal });
      return;
    }
    const { agent } = launch; // the agent the reducer recorded on the worker (#925), a manual start's pick included (#290)
    const runner = runners[agent];
    let cwd: string;
    let env: Record<string, string>;
    let workspace: string;
    let external: readonly RunMcpServer[];
    let protocolText: string;
    const protocolPath = taskProtocol(home, runtime, task).stage; // spawn, Continue and feedback alike: the session ends the stage itself (#167); its workspace's memory under it (#797)
    try {
      const resolved = requireWorkspace(config, task);
      workspace = resolved.name;
      external = await externalMcp(config, resolved.name); // #333
      env = await runEnv(exec, resolved); // #738, #854: the workspace prepare resolves, a fork's GH_REPO under its env; one a save removed fails the same way
      cwd = await prepare(runtime, activity, task, ptyId);
      protocolText = await readFile(protocolPath, 'utf8'); // #927: Codex takes the protocol as text; an unreadable file fails the run here, never a run left with no pty
    } catch (err) {
      await dispatch({ type: 'spawnFailed', ptyId, message: errorMessage(err) });
      return;
    }
    // A Stop during the setup aborted it (abortSetup) and its exit freed the worker; one that landed right after the setup freed it too: no worker then.
    if (!isLive(ptyId)) return;
    if (effect.run === 'stage') await recordStart(runtime, activity, task, stage.name); // before the worker exists: nothing it commits can land first
    const promptPath = await writePrompt(promptsDir, slug, runPrompt(effect)); // the command line reads it
    const server = { port, ptyId, secret, withHive: true, external };
    const mcpPath = await writeMcpConfig(promptsDir, ptyId, runner.mcpConfig(server)); // the tools' channel (#99); Claude's path puts the pty id in its argv
    await plugin.ready(); // #316: again after the setup's awaits, so a render queued meanwhile is swapped in before launch reads the folder
    const run: AgentRun = {
      ptyId, cwd, port, withHive: true, external, hooksPath, pluginDir: launch.pluginDir, mcpPath, lspPluginDir: lspDir(workspace), ...launch.picked, session: runSession(activity.sessionId, session),
      protocolPath, protocolText, // #927: Codex takes the protocol as text; Claude keeps the path. picked: runModel's model, the config's args (#924) then the picks' (#290)
    };
    pool.start({
      ptyId,
      // #927: the runner's env over the workspace's, so no workspace variable can stand in for the MCP secret
      launch: { ptyId, slug, cwd, env: { ...env, ...runner.runEnv(server) }, port, promptPath, ...sized(size), agent: { command: AGENTS[agent].command, argv: runner.launch(run) } },
      ...handlers(ptyId, slug),
    });
  }

  // The user's own agent session (#164, #283), a task's or a workspace's local one (#587). Its cwd exists (the reducer checked it), so no
  // worktree step. A task's run has the MCP on; a local one an MCP config with no server (hive_done has no task there). A copy's first run
  // (#587) forks the source, and its notice is the first prompt; the open route's prompt (#758) is one too. Either goes in a file of its own:
  // the task's <slug>.md is its stage prompt.
  async function spawnSession(runtime: Runtime, effect: SessionEffect, size?: TerminalSize): Promise<void> {
    const { worker: { runId: ptyId }, task, sessionId, continues, copy, prompt } = effect;
    if (!ptyId) return;
    const { config, hooksPath, promptsDir, port } = runtime;
    const place = await sessionRun(config, effect, plugin); // #317: its folder too, before anything is recorded
    if ('refusal' in place) {
      await dispatch({ type: 'spawnFailed', ptyId, message: place.refusal });
      return;
    }
    // #925: the worker carries its agent: a copy its source's, a resume its session's, a new session the one the route asked for
    const agent = ranAgent(effect.worker);
    const picked = launchRun(copy ? undefined : effect.worker.launch, config.agentArgs[agent], () => specializedAgents(place.pluginDir)); // #257: a copy never runs with its source's picks
    if ('refusal' in picked) {
      await dispatch({ type: 'spawnFailed', ptyId, message: picked.refusal });
      return;
    }
    // Refused above, before the stage start is recorded: a session that never runs leaves no mark
    // #812: a free session on a task records the stage start when the stage has none, before the agent runs, so Restart can undo its work. A
    // repo session runs in the main repo, and a checkout task in the user's own checkout, which Restart never resets (#444): nothing to record
    if (task !== undefined && !effect.activity.local && !(continues && effect.repo === true)) await recordStart(runtime, effect.activity, task, task.stage);
    const env = await runEnv(exec, place.workspace); // #854
    const external = await externalMcp(config, place.workspace.name); // #333: a local session gets them too, still no Hive tools
    const first = copy?.notice ?? prompt;
    const runner = runners[agent];
    const server = { port, ptyId, secret, withHive: task !== undefined, external };
    // the protocol goes where the Hive's tools go (#167): a task's session has both, a local one neither (the same test as the MCP's)
    const protocolPath = task === undefined ? undefined : taskProtocol(home, runtime, task).session; // #797: the task's workspace's
    // A write that fails leaves no run to exit: spawnFailed frees the worker, and a copy's temporary transcript goes with it (#587)
    const files = await Promise.all([
      writeMcpConfig(promptsDir, ptyId, runner.mcpConfig(server)),
      first === undefined ? undefined : writePrompt(promptsDir, ptyId, first),
      protocolPath === undefined ? undefined : readFile(protocolPath, 'utf8'), // #927: its text, for an agent that takes it so
    ]).catch(async (err: unknown) => { await dispatch({ type: 'spawnFailed', ptyId, message: errorMessage(err) }); });
    if (files === undefined) return;
    const [mcpPath, promptPath, protocolText] = files;
    await plugin.ready(); // #316: as spawn's, after the last await
    const run: AgentRun = {
      ptyId, cwd: place.cwd, port, withHive: server.withHive, external, hooksPath, pluginDir: place.pluginDir, mcpPath, lspPluginDir: lspDir(place.workspace.name), ...picked,
      session: runSession(sessionId, continues ? 'continue' : 'new'), ...(protocolPath === undefined ? {} : { protocolPath, protocolText }),
    };
    const argv = copy ? runner.copy(run, copy.from, copy.name) : runner.launch(run);
    if (argv === undefined) {
      await dispatch({ type: 'spawnFailed', ptyId, message: `${AGENTS[agent].label} cannot copy a session` });
      return;
    }
    pool.start({
      ptyId,
      launch: { ptyId, slug: place.slug, cwd: place.cwd, env: { ...env, ...runner.runEnv(server) }, port, ...(promptPath === undefined ? {} : { promptPath }), ...sized(size), agent: { command: AGENTS[agent].command, argv } },
      ...handlers(ptyId, place.slug),
    });
  }

  // A plain terminal's launch (#696): where it wakes (the cwd it held while on disk, else its start dir), its own history, and its ring:
  // written to its log as it ends, the old one replayed first after a sleep. Its env is the workspace's (#738) under its own HISTFILE, and
  // the shim dir goes first on the workspace's PATH when it sets one, so an agent typed there is still its shim's.
  async function keptLaunch(terminal: Terminal, startDir: string, env: Record<string, string>): Promise<Pick<PtyLaunch, 'cwd' | 'env' | 'keep'>> {
    await ensureTerminalsDir(home);
    const [cwd, seed] = await Promise.all([wakeDir(terminal.cwd, startDir), readScrollback(home, terminal.terminalId)]);
    const log = scrollbackPath(home, terminal.terminalId);
    const own = terminalEnv(home, terminal.terminalId, env.PATH ?? process.env.PATH ?? '');
    return { cwd, env: { ...env, ...own }, keep: seed === undefined ? { log } : { log, seed } };
  }

  // A terminal (#283): the pool runs it in a pty (#251) like any run, with no agent, no MCP and no prompt. A run command (#300) is looked up
  // by name only now, and its output to the console (#353): a click the config changed since fails in the bar instead of running something
  // else. No task: a workspace's shell (#292). Its env is the workspace's (#348, #738); a command's own is exported over it. A plain one is kept (#696).
  async function spawnTerminal(runtime: Runtime, { terminal, activity, task }: Extract<Effect, { type: 'spawnTerminal' }>, size?: TerminalSize): Promise<void> {
    if (activity.kind === 'local' || !task) return spawnProjectShell(runtime, terminal, size);
    const { terminalId: ptyId } = terminal;
    const { config, port } = runtime;
    const workspace = taskWorkspace(config, task);
    if (!workspace) {
      await dispatch({ type: 'spawnFailed', ptyId, message: noWorkspaceReason(task) });
      return;
    }
    // a command not enabled here (a save raced the click) fails in the bar (#511)
    const found = terminal.command === undefined ? undefined : commandIn(config.comb.commands, workspace.name, terminal.command);
    if (terminal.command !== undefined && !found) {
      await dispatch({ type: 'spawnFailed', ptyId, message: `comando "${terminal.command}" não está habilitado no workspace ${workspace.name}` });
      return;
    }
    const startDir = taskDir(workspace.path, activity);
    const env = await runEnv(exec, workspace); // #854: a fork's GH_REPO, resolved once per launch
    const where = found ? { cwd: startDir, env } : await keptLaunch(terminal, startDir, env); // a command's run is never kept (#696)
    pool.start({
      ptyId,
      launch: {
        ptyId, slug: workSlug(activity, task), port, terminal: true, ...where, ...sized(size),
        ...(found ? { run: { command: found.command, env: found.env } } : {}),
      },
      ...handlers(ptyId, workSlug(activity, task)),
    });
    // A run command's output goes to its console channel (#353); its timeout (#511) stops it the way its Stop does, through the reducer's kill
    if (found) feedConsole({ ptys, consoleStore }, commandChannel(workspace.name, found.name), ptyId, { label: `#${task.item.id}`, timeout: found.timeout, onTimeout: () => void dispatch({ type: 'stop', ptyId }) });
  }

  // A workspace's shell (#292): the user's shell in the main checkout, on whatever branch is checked out there, with no task, no worktree, no
  // checkout and no setup. A name a save removed since the click fails in the bar, as a gone run command does.
  async function spawnProjectShell(runtime: Runtime, terminal: Terminal, size?: TerminalSize): Promise<void> {
    const { terminalId: ptyId } = terminal;
    const name = localWorkspaceOf(terminal.activityId) ?? '';
    const { config, port } = runtime;
    const workspace = workspaceByName(config, name);
    if (!workspace) {
      await dispatch({ type: 'spawnFailed', ptyId, message: `workspace "${name}" não existe mais` });
      return;
    }
    pool.start({
      ptyId,
      launch: { ptyId, slug: LOCAL_SLUG, port, terminal: true, ...sized(size), ...(await keptLaunch(terminal, workspace.path, await runEnv(exec, workspace))) },
      ...handlers(ptyId, LOCAL_SLUG),
    });
  }

  const abortSetup = (ptyId: string): void => setups.get(ptyId)?.abort();

  return { spawn, spawnSession, spawnTerminal, recordStart, abortSetup, prepare };
}
