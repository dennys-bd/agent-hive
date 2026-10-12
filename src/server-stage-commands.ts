import { stripVTControlCharacters } from 'node:util';
import { noWorkspaceReason, taskWorkspace } from './config.js';
import { type ConsoleStore, runHeader, stageChannel } from './console.js';
import { feedConsole } from './console-feed.js';
import { runEnv } from './fork.js';
import type { PtyHost } from './pty-host.js';
import type { PtyPool } from './ptys.js';
import { commandIn, type ResolvedCommand, resolveCommand } from './run-commands.js';
import type { Runtime } from './server.js';
import { taskBranch } from './task-runs.js';
import { branchFor, slugFor } from './tasks.js';
import type { Activity, Command, Effect, Exec, HiveEvent, StageCommands, Task } from './types.js';
import { taskDir } from './worktree.js';

// How a commands stage's command runs (#755), out of server-spawn.ts: in a pty of its own, launched as a command terminal is (ptyCommand's
// existing command render), its output on the stage's console channel, its end answered with stageCommandEnded. No Terminal enters the State.

type StageCommandEffect = Extract<Effect, { type: 'stageCommand' }>;

export interface StageCommandDeps {
  exec: Exec; // #854: the remote read behind a fork's GH_REPO
  pool: Pick<PtyPool, 'start' | 'kill'>;
  ptys: Pick<PtyHost, 'has' | 'subscribe'>;
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  prepare(runtime: Runtime, activity: Activity, task: Task, ptyId: string): Promise<string>; // the spawner's: the worktree and its setup
  current(activityId: string): StageCommands | undefined; // the run the State holds now: a Stop during the setup dropped it
}

export interface StageCommandRunner { run(runtime: Runtime, effect: StageCommandEffect): Promise<void> }

/** The most of a failed command's output the record keeps (#755), in characters, ANSI codes stripped: it has to fit a later prompt. */
export const OUTPUT_MAX = 16_000; // ponytail: a fixed tail; a setting if a prompt ever needs more of it
const RAW_MAX = OUTPUT_MAX * 4; // room for the escape codes the strip removes
const NOT_STARTED_EXIT = 127; // the shell's own code for a command it could not start: a pty that never spawned
/** How often a running command's output reaches the State (#914), per pty: the running block's silence line needs the last output's time, and
 * every chunk would flood the SSE. 30 s is the CI read's period. */
export const OUTPUT_THROTTLE_MS = 30_000;

/** The last OUTPUT_MAX characters of a command's output with its ANSI codes gone (#755): what stageCommandEnded carries. */
export const outputTail = (raw: string): string => stripVTControlCharacters(raw).slice(-OUTPUT_MAX);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The names the stage cannot get past (#755): one the Comb no longer has, whatever onMissing says (a configuration error, never skipped); one
// with no line in the task's workspace unless the stage skips it. Each as the refusal names it
function refusals(commands: readonly Command[], names: readonly string[], workspace: string, skips: boolean): string[] {
  return names.flatMap((name) => {
    const found = commands.find((c) => c.name === name);
    if (found === undefined) return [`${name}: not in comb.commands`];
    return skips || resolveCommand(found, workspace) !== undefined ? [] : [`${name} missing in ${workspace}`];
  });
}

export function createStageCommandRunner(deps: StageCommandDeps): StageCommandRunner {
  const { pool, ptys, consoleStore, dispatch, prepare, current } = deps;
  const refuse = async (activityId: string, ptyId: string, message: string): Promise<void> => {
    await dispatch({ type: 'stageCommandsRefused', activityId, ptyId, message });
  };

  // Index 0 prepares the worktree as a spawn does, its setup included, and records it on the activity (no SessionStart will, #755); a later
  // index runs where the first one did. Undefined when a Stop landed during the setup: nothing runs then
  async function workDir(runtime: Runtime, { activity, task, at, ptyId }: StageCommandEffect, repo: string): Promise<string | undefined> {
    if (at > 0) return taskDir(repo, activity);
    const cwd = await prepare(runtime, activity, task, ptyId);
    if (current(activity.id)?.ptyId !== ptyId) return undefined;
    const branch = taskBranch(activity, branchFor(runtime.config, task.item));
    await dispatch({ type: 'worktreeReady', activityId: activity.id, path: cwd, branch, base: activity.base ?? null, local: activity.local === true });
    return cwd;
  }

  // The command's pty, launched as a command terminal is: the worktree as cwd, the workspace's env under the command's own; its output fed
  // to the stage's channel and kept as a bounded tail. Its timeout kills it through the pool, never through the reducer's stop, which would
  // drop the run and lose the verdict
  function start(runtime: Runtime, { activity, task, stage, at, ptyId }: StageCommandEffect, command: ResolvedCommand, cwd: string, env: Record<string, string>): void {
    const ended = (code: number, output: string): void => void dispatch({ type: 'stageCommandEnded', activityId: activity.id, ptyId, code, output });
    pool.start({
      ptyId,
      launch: {
        ptyId, slug: activity.slug ?? slugFor(task.item), cwd, env, port: runtime.port, terminal: true,
        run: { command: command.command, env: command.env },
      },
      onExit: () => undefined, // the end and its code come from the pty host's subscription below; the pool's exit carries no code
      onError: (message) => void dispatch({ type: 'error', message: `stage ${stage.name}: ${message}` }),
      onSpawnFailed: (message) => ended(NOT_STARTED_EXIT, message),
    });
    let raw = '';
    let lastOutput = Number.NEGATIVE_INFINITY; // #914: this pty's last stageCommandOutput; each command has a pty of its own
    const output = (): void => {
      const now = Date.now();
      if (now - lastOutput < OUTPUT_THROTTLE_MS) return;
      lastOutput = now;
      void dispatch({ type: 'stageCommandOutput', activityId: activity.id, ptyId, at: new Date(now).toISOString() });
    };
    // A pty the host does not hold never reports an end: answered now, or the stage would wait forever and only a Stop would free the task
    const fed = feedConsole({ ptys, consoleStore }, stageChannel(stage.name), ptyId, {
      group: activity.commands?.runId,
      label: `#${task.item.id} · running ${command.name} · ${at + 1}/${stage.commands?.length ?? 0}`,
      timeout: command.timeout,
      onTimeout: () => {
        raw += `\r\ntimed out after ${command.timeout ?? ''}`;
        void pool.kill(ptyId);
      },
      onData: (data) => {
        raw = (raw + data).slice(-RAW_MAX);
        output();
      },
      onEnd: (code) => ended(code, outputTail(raw)),
    });
    if (!fed) ended(NOT_STARTED_EXIT, `pty ${ptyId} did not start`);
    else void dispatch({ type: 'stageCommandStarted', activityId: activity.id, ptyId, at: new Date().toISOString() }); // #914: the block's clock
  }

  // A command with no line in the task's workspace, under onMissing skip (#755): one line in the execution's console output and nowhere else,
  // then the stage goes on as after a 0, so a stage that skips them all passes
  async function skip({ activity, task, stage, at, ptyId }: StageCommandEffect, workspace: string): Promise<void> {
    const name = stage.commands?.[at] ?? '';
    consoleStore.begin(stageChannel(stage.name), ptyId, runHeader(`#${task.item.id} · skipped · ${name} missing in ${workspace}`, new Date()), activity.commands?.runId);
    consoleStore.end(ptyId, 0);
    await dispatch({ type: 'stageCommandStarted', activityId: activity.id, ptyId, at: new Date().toISOString(), skipped: true }); // #914: the block's pulado
    await dispatch({ type: 'stageCommandEnded', activityId: activity.id, ptyId, code: 0, output: '' });
  }

  // Index 0 checks every name in the task's workspace and refuses the stage before anything runs; a later index checks its own, which a save
  // may have removed since. Under skip, a name with no line is skipped when its turn comes, after index 0 prepared the worktree the later
  // ones run in
  async function run(runtime: Runtime, effect: StageCommandEffect): Promise<void> {
    const { activity, task, stage, at, ptyId } = effect;
    const workspace = taskWorkspace(runtime.config, task);
    if (!workspace) return refuse(activity.id, ptyId, noWorkspaceReason(task));
    const names = stage.commands ?? [];
    const { commands } = runtime.config.comb;
    const refused = refusals(commands, at === 0 ? names : names.slice(at, at + 1), workspace.name, stage.onMissing === 'skip');
    if (refused.length > 0) return refuse(activity.id, ptyId, refused.join('\n'));
    let cwd: string | undefined;
    try {
      cwd = await workDir(runtime, effect, workspace.path);
    } catch (err) {
      return refuse(activity.id, ptyId, errorMessage(err));
    }
    if (cwd === undefined) return;
    const command = commandIn(commands, workspace.name, names[at] ?? '');
    if (command === undefined) return skip(effect, workspace.name);
    start(runtime, effect, command, cwd, await runEnv(deps.exec, workspace)); // #854: a fork's GH_REPO under the workspace's env
  }

  return { run };
}
