import { activityOf, resultOf } from '../../activities';
import { stageChannel } from '../../console';
import { type SpawnFailureCode, spawnFailureCode } from '../../spawn-failure';
import { stageOf } from '../../tasks';
import { CHECKS_FAILED, CI_FAILED, NO_TRANSITION, SPAWN_FAILED, TRIES_OUT, type State, type Task } from '../../types';
import { ciProgress } from '@/components/CiProgress';
import { Button } from '@/components/ui/button';
import { useOpenStageOutput } from '@/hooks/use-console';
import { type MessageKey, t } from '@/i18n';
import { exitLabel } from '@/lib/flow-labels';

// A commands stage on the task (#755): the command running while the stage runs, the failure once it failed, and the way to its output, the
// activity's locked console tab. The card's footer and the status box read these.

type Work = Pick<State, 'stages' | 'activities' | 'activityRecords'>;

/** The command running and its place in the stage's list, `executando lint · 2/4`; undefined while no commands stage runs, and while the worktree
 * setup runs, whose own line shows first. */
export function commandsProgress(task: Task, state: Work): string | undefined {
  const live = activityOf(state, task.item.itemId);
  const run = live?.commands;
  if (run === undefined || live?.setup !== undefined) return undefined;
  const names = stageOf(state.stages, run.stage)?.commands ?? [];
  return t('stageCommands.running', { name: names[run.at] ?? '', n: run.at + 1, total: names.length });
}

// #945: one short message per spawn failure code; a map, not a template key, so tsc checks every code has its copy
const START_FAILED: Record<SpawnFailureCode, MessageKey> = {
  agent_missing: 'start.failed.agent_missing', no_workspace: 'start.failed.no_workspace', workspace_gone: 'start.failed.workspace_gone',
  command_disabled: 'start.failed.command_disabled', setup_failed: 'start.failed.setup_failed', checkout_dirty: 'start.failed.checkout_dirty',
  git_failed: 'start.failed.git_failed', pty_failed: 'start.failed.pty_failed', error: 'start.failed.error',
};

/** A failed start's error (#945): what the reducer's spawnFailed writes on the activity. */
export const isStartFailure = (error: string | undefined): error is string => error?.startsWith(SPAWN_FAILED) === true;
/** The spawn's own message behind a failed start's error (#945): a path, git's lines; the details panel shows it only when asked. */
export const startFailureRaw = (error: string): string => error.slice(SPAWN_FAILED.length);

/** A task's error as the page shows it: a failed start's short message, a commands stage's or a wait for CI's failure, a stage end with no
 * transition, a transition out of tries (#945, #755, #834, #134), in the viewer's language; any other as the state holds it. */
export function taskError(error: string): string {
  if (error.startsWith(SPAWN_FAILED)) return t(START_FAILED[spawnFailureCode(startFailureRaw(error))]); // not isStartFailure: its guard would narrow the rest to never
  if (error.startsWith(CHECKS_FAILED)) return t('stageCommands.failed', { list: error.slice(CHECKS_FAILED.length) });
  if (error.startsWith(CI_FAILED)) return t('stageCi.failed', { list: error.slice(CI_FAILED.length) });
  if (error.startsWith(NO_TRANSITION)) return t('stage.error.noTransition', { trigger: exitLabel(error.slice(NO_TRANSITION.length)) });
  if (!error.startsWith(TRIES_OUT)) return error;
  const [name, max] = error.slice(TRIES_OUT.length).split(' · ');
  return t('stage.error.triesOut', { trigger: exitLabel(name), n: max ?? '' });
}
const FAILURES: readonly string[] = [CHECKS_FAILED, CI_FAILED, NO_TRANSITION, TRIES_OUT];
const isStageFailure = (error: string | undefined): error is string => error !== undefined && FAILURES.some((prefix) => error.startsWith(prefix));

// The stage whose output ver saída opens: the one running, else the task's own once its commands failed there
function outputStage(task: Task, state: Work): string | undefined {
  const live = activityOf(state, task.item.itemId);
  if (live?.commands !== undefined) return live.commands.stage;
  return live?.error?.startsWith(CHECKS_FAILED) ? task.stage : undefined;
}

// The execution ver saída shows: the running one, else the one the record's verdict names; none, no link, never a tab of the whole channel
function outputRun(task: Task, state: Work): string | undefined {
  const live = activityOf(state, task.item.itemId)?.commands;
  if (live !== undefined) return live.runId;
  const verdict = resultOf(state, task.item.itemId)?.commands;
  const runId = typeof verdict === 'object' && verdict !== null ? (verdict as { runId?: unknown }).runId : undefined;
  return typeof runId === 'string' ? runId : undefined;
}

/** ver saída: the task's locked console tab on its commands stage's channel, scoped to that execution. Nothing outside a Dashboard, with no
 * commands stage to show or no execution to name. */
export function StageOutputButton({ task, state }: { task: Task; state: Work }) {
  const open = useOpenStageOutput();
  const stage = outputStage(task, state);
  const run = outputRun(task, state);
  if (open === undefined || stage === undefined || run === undefined) return null;
  return (
    <Button
      type="button" variant="ghost" size="xs" className="h-auto px-1.5 py-0.5 font-normal text-muted-foreground text-xs"
      onClick={() => open(task.item.itemId, stageChannel(stage).id, run)}
    >
      {t('stageCommands.viewOutput')}
    </Button>
  );
}

/** The status box's line: a commands stage's progress or a wait for CI's (#834), the failure after either, with ver saída where there is output;
 * nothing otherwise. */
export function CommandsLine({ task, state }: { task: Task; state: Work }) {
  const error = activityOf(state, task.item.itemId)?.error;
  const text = commandsProgress(task, state) ?? ciProgress(task, state) ?? (isStageFailure(error) ? taskError(error) : undefined);
  if (text === undefined) return null;
  return (
    <p className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
      <span className="min-w-0 truncate">{text}</span>
      <StageOutputButton task={task} state={state} />
    </p>
  );
}
