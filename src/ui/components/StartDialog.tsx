import { type KeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { activityOf, workIdOf } from '../../activities';
import { startMode, startsFresh } from '../../task-runs';
import { canOpenSession, HIVE_SOURCE, resolveWorkspace } from '../../tasks';
import { DISCARD_FAILED, type Task, type OpenResult, type SetupRows, type State } from '../../types';
import { act, attachRun } from '@/components/actions';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { TaskPicker } from '@/components/TaskPicker';
import { SetupProgressView, SetupSubmit } from '@/components/SetupProgress';
import { ButtonKeyHint } from '@/components/KeyHint';
import { RunFields, type RunFieldsProps } from '@/components/RunFields';
import { RunCustomize, RunSummary } from '@/components/RunSummary';
import { BaseField, modeAfterKey, ModeToggle, StagesBox, type StartMode } from '@/components/StartFields';
import { useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { type Answer, sessionStatus, type SetupView, useSetupView } from '@/hooks/use-setup-view';
import { usePendingTask, useAutoStart } from '@/hooks/use-pending-task';
import { isChanged, openBody, resumedLaunch, type RunPicks, type RunPickState, startBody, useRunPick } from '@/hooks/use-run-pick';
import { baseBody, type BaseChoice, useStartBase } from '@/hooks/use-start-base';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { CreateTargetsContext, destinations } from '@/lib/create-targets';
import { pressed } from '@/lib/shortcut-bindings';
import { hasStagesToRun } from '@/lib/start-flow';
import { shownSize } from '@/lib/xterm-setup';

export interface StartDialogProps {
  state: State;
  taskId?: string; // Iniciar #id from a task (#543); absent: Nova atividade, picking or creating the task
  initialMode?: StartMode; // abrir sessão opens it on sessão livre; every other way in, on executar etapas
  workspace?: string; // the workspace whose + opened it: where a task created here runs
  title?: string; // + criar tarefa from the search (#584): with no taskId, the task this dialog creates on arrival
  onStarted?(taskId: string): void; // a stages run: its task goes to the center once the run shows (#457)
  onActivity?(taskId: string): void; // #587: the activity the dialog started or opened a session on, whichever mode
  onClose(): void;
}

const taskPath = (itemId: string): string => `/tasks/${encodeURIComponent(itemId)}`;
// Candidates: every task the Hive holds, but those leaving it or gone from their source
const pickable = (state: State): Task[] => state.tasks.filter((c) => !c.missing && !c.leaving && !activityOf(state, c.item.itemId)?.deleting);

// executar etapas: the stage's start with the base chosen and the run picks (#290: {} while they are the stage's), or its continue once the
// stage already ran (#283), which resumes the stage's session as it ran. A task this dialog created
// was created with auto off, so the fill left it alone until now; the start taken, it becomes a task like any other and the flow goes on (redesign 11)
async function runStages(task: Task, state: State, base: BaseChoice, created: boolean, picks: Record<string, unknown>): Promise<void> {
  const path = taskPath(task.item.itemId);
  const work = workIdOf(state, task.item.itemId); // the live activity, else a deleted one's record whose session the continue resumes (#629)
  const mode = startMode(task, state);
  if (typeof mode === 'object' && mode.continue && work !== undefined) await postJson(`/activities/${encodeURIComponent(work)}/continue`, { size: shownSize() }); // #812: after a free run, a start
  else await postJson(`${path}/start`, { ...baseBody(base), ...picks, size: shownSize() });
  if (created) await act(`${path}/auto`, { auto: true });
}

// sessão livre: the agent opened on the task with no prompt, a new session with its explicit picks or a resumed one with its record's (#257,
// #290). The caller attaches the run it answers, unless the dialog closed meanwhile (#351)
function openFree(task: Task, state: State, base: BaseChoice, picks: RunPicks): Promise<OpenResult> {
  const body = { ...openBody(picks, task, state), ...baseBody(base), size: shownSize() };
  return postJson<OpenResult>(`${taskPath(task.item.itemId)}/open`, body);
}

// The stage a task created here enters: the first stage with a prompt, so executar etapas has something to run
const createStage = (state: State): string | undefined => (state.stages.find((s) => s.prompt !== undefined) ?? state.stages[0])?.name;
// A task with no stage left to run (#774): executar etapas is off for it, so the dialog lands on sessão livre on its arrival and on its pick
const nothingToRun = (state: State, itemId: string | undefined): boolean => {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  return task !== undefined && !hasStagesToRun(task.stage, state.stages);
};

// Why the start cannot go yet, or undefined: no task, bases still loading or asking for the workspace, or a task with nothing to run in the
// mode. The button and ⌘↵ both read it
function blocker(task: Task | undefined, state: State, mode: StartMode, base: BaseChoice): boolean {
  if (task === undefined || base.lists === undefined || base.lists.needsWorkspace) return true;
  if (mode === 'free') return !canOpenSession(task, activityOf(state, task.item.itemId));
  const run = startMode(task, state);
  return !(run === 'start' || (typeof run === 'object' && run.live === undefined));
}

// Every task this dialog created (redesign 11), created with auto off so the fill leaves it alone: the ones not started go when the dialog ends,
// and one created after the dialog ended goes at once
function useCreatedTasks(state: State, workspace: string | undefined, done: { current: boolean }, onError: (message: string) => void) {
  const created = useRef(new Set<string>());
  const create = (title: string, then: (itemId: string) => void): void => {
    const body = { title, stage: createStage(state), auto: false, source: HIVE_SOURCE, ...(workspace === undefined ? {} : { workspace }) };
    postJson<{ itemId: string }>('/tasks', body).then(({ itemId }) => {
      if (done.current) return void act(`${taskPath(itemId)}/close`);
      created.current.add(itemId);
      then(itemId);
    }, (err: Error) => onError(err.message));
  };
  const drop = (keep?: string): void => {
    for (const itemId of created.current) if (itemId !== keep) void act(`${taskPath(itemId)}/close`);
    created.current.clear();
  };
  return { create, drop, has: (itemId: string): boolean => created.current.has(itemId) };
}

// The dialog's state and actions: the pick (or the task created here), the mode, the session, the base, and the start itself
// + criar tarefa from the search (#584): the task is created once on arrival, as the picker's create row would. A ref, not the effect's
// deps, keeps a second effect run (StrictMode) from creating a second one
function useCreateOnOpen(title: string | undefined, create: (title: string) => void): void {
  const asked = useRef(false);
  useEffect(() => {
    if (title === undefined || asked.current) return;
    asked.current = true;
    create(title);
  });
}

// The create row (#846): the destinations the context offers, the tasks created in the hive at once, and the entry held for a source. A
// source creates nothing until the activity starts, so a cancel leaves no issue behind
function useCreateRow(state: State, workspace: string | undefined, done: { current: boolean }, onError: (message: string) => void, pick: (itemId: string) => void, unpick: () => void) {
  const choices = destinations(useContext(CreateTargetsContext));
  const created = useCreatedTasks(state, workspace, done, onError);
  const held = usePendingTask(createStage(state), onError);
  const create = (text: string, destination = choices[0]): void => {
    if (destination !== HIVE_SOURCE) { unpick(); held.hold({ title: text, source: destination }); return; }
    held.hold(undefined);
    created.create(text, pick);
  };
  // a pick of a task replaces the held entry: left behind, the submit would create its issue and start it instead of the pick
  const pickTask = (itemId: string): void => { held.hold(undefined); pick(itemId); };
  return { choices, created, held, create, pickTask };
}

// The pick (or the task created here) and the mode; the run picks follow the pick on their own (useRunPick)
function useTaskPick(state: State, taskId: string | undefined, initialMode: StartMode, setError: (message: string | undefined) => void) {
  const [picked, setPicked] = useState(taskId);
  const [mode, setMode] = useState<StartMode>(() => (nothingToRun(state, taskId) ? 'free' : initialMode)); // #774: not an effect, no frame on stages
  const task = state.tasks.find((c) => c.item.itemId === picked);
  const pick = (itemId: string): void => { setPicked(itemId); setError(undefined); };
  return { picked, setPicked, mode, setMode, pick, task };
}

interface EndDeps {
  done: { current: boolean }; created: { drop(keep?: string): void }; openRun: ReturnType<typeof useOpenRun>;
  onStarted?(taskId: string): void; onActivity?(taskId: string): void; onClose(): void;
  setPending(pending: boolean): void; setError(message: string): void;
}

// How a start or an open ends once the preparing view lets it (#390): the dialog closes on its run, or says why it did not start
const endOf = (deps: EndDeps, task: Task) => (answer: Answer): void => {
  const itemId = task.item.itemId;
  if (deps.done.current) return; // closed meanwhile: nothing attaches it, the task carries the session (#351)
  if (!answer.ok) {
    deps.setPending(false);
    deps.setError(answer.error.code === DISCARD_FAILED ? `${t('start.orphan.failed')}\n${answer.error.message}` : answer.error.message); // #861: git's words under the dialog's own heading
    return;
  }
  deps.done.current = true;
  deps.created.drop(itemId);
  if (answer.opened) attachRun(answer.opened, task, 'session', deps.openRun); // in the center at once (#249, #491)
  else deps.onStarted?.(itemId);
  deps.onActivity?.(itemId);
  deps.onClose();
};

function useStart({ state, taskId, initialMode = 'stages', workspace, title, onStarted, onActivity, onClose }: StartDialogProps) {
  const openRun = useOpenRun();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [isCreating, setIsCreating] = useState(false); // a source create in flight: closing then would leave its issue behind
  const done = useRef(false); // started or closed: a late answer changes nothing
  const heldIds = useRef(new Set<string>()); // the source tasks the held entry became: created with auto off, like the hive ones
  const onError = useCallback((message: string) => setError(message), []);
  const { picked, setPicked, mode, setMode, pick, task } = useTaskPick(state, taskId, initialMode, setError);
  const run = useRunPick(state, task, useContext(DefaultAgentContext));
  const view = useSetupView(task && activityOf(state, task.item.itemId)); // #390
  const base = useStartBase(picked, onError);
  const { choices, created, held, create, pickTask } = useCreateRow(state, workspace, done, onError, pick, () => setPicked(undefined));
  useCreateOnOpen(taskId === undefined ? title : undefined, create);
  const isBlocked = held.entry === undefined && blocker(task, state, mode, base.choice);
  const close = (): void => {
    if (isCreating) return;
    // created here and never started: they go. A start on its way keeps its task
    if (!done.current) created.drop(pending ? picked : undefined);
    done.current = true;
    onClose();
  };
  const startHeld = async (): Promise<void> => {
    setPending(true); setIsCreating(true); setError(undefined);
    try {
      const itemId = await held.create();
      if (itemId === undefined || done.current) return;
      heldIds.current.add(itemId);
      pick(itemId);
    } finally {
      setPending(false); setIsCreating(false); // whatever happened, Cancel and the start button come back
    }
  };
  const submit = (): void => {
    if (held.entry !== undefined) return void startHeld();
    if (task === undefined || pending || isBlocked) return;
    held.clearAwaiting(); setPending(true); setError(undefined);
    const itemId = task.item.itemId;
    const isCreated = created.has(itemId) || heldIds.current.has(itemId); // created with auto off either way: the start turns it on
    const settle = view.begin(endOf({ done, created, openRun, onStarted, onActivity, onClose, setPending, setError }, task), () => { setPending(false); created.drop(itemId); }); // #390: a failed setup stays on the view, its task kept
    const request = mode === 'stages' ? runStages(task, state, base.choice, isCreated, startBody(run.picks, run.initial)) : openFree(task, state, base.choice, run.picks);
    request.then((opened) => { if (!done.current) settle({ ok: true, ...(opened ? { opened } : {}) }); }, (error: Error & { code?: string }) => {
      if (done.current) { if (isCreated) void act(`${taskPath(itemId)}/close`); return; } // closed while it was on its way: a task created here that never started goes
      settle({ ok: false, error });
    });
  };
  useAutoStart(held.awaiting, task, isBlocked || pending || done.current, () => { held.clearAwaiting(); submit(); });
  return { task, picked, mode, setMode, run, error, pending, isCreating, base, isBlocked, pick: pickTask, create, close, submit, choices, held: held.entry, view };
}

// Whether personalizar is offered (#290): only on a start; never on a continue, whose session is fixed, nor while a handover decides the run (#134)
const isCustomizable = (task: Task | undefined, state: State): boolean =>
  task !== undefined && startsFresh(startMode(task, state)) && activityOf(state, task.item.itemId)?.handover === undefined;

// The run fields with the agents' lists (#290), fetched once when they first show, for the run's workspace (#316): the stages box alone asks for nothing
function RunFieldsLoaded({ workspace, ...props }: Omit<RunFieldsProps, 'options'> & { workspace?: string }) {
  return <RunFields {...props} options={useLaunchOptions(workspace)} />;
}

// The run part of the dialog (#290): the stages box in executar etapas, the run fields in sessão livre. Only a stage run resolves an empty
// model through the stage (stageModel); a free session's is the agent's default
function RunSection({ id, mode, task, state, run, workspace }: { id: string; mode: StartMode; task?: Task; state: State; run: RunPickState; workspace?: string }) {
  const fields = (initial?: RunPicks): ReactNode => (
    <RunFieldsLoaded id={id} workspace={workspace} task={task} state={state} picks={run.picks} initial={initial} onPicks={run.set}
      stageModel={mode === 'stages' ? run.stageModel : undefined}
      locked={mode === 'free' && task !== undefined ? resumedLaunch(run.picks, task, state) : undefined} />
  );
  if (mode === 'free') return fields();
  const canCustomize = isCustomizable(task, state);
  return (
    <>
      <StagesBox task={task} stages={state.stages} run={<RunSummary picks={run.picks} stageModel={run.stageModel} isCustomizable={canCustomize} isOpen={run.isCustomizing} onToggle={run.setCustomizing} />} />
      {canCustomize && run.isCustomizing && task && (
        <RunCustomize stage={task.stage} isChanged={isChanged(run.picks, run.initial)} onRestore={run.restore}>{fields(run.initial)}</RunCustomize>
      )}
    </>
  );
}

// The dialog's title and subtitle (#390: the preparing view has its own title and always names the task under it)
function StartHeader({ id, task, isNew, isPreparing }: { id: string; task?: Task; isNew: boolean; isPreparing: boolean }) {
  const title = task === undefined || (isNew && !isPreparing) ? t('start.newTitle') : t(isPreparing ? 'setupProgress.title' : 'start.title', { id: task.item.id });
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {task && (!isNew || isPreparing) && <DialogDescription id={`${id}-sub`} className="text-[13px]">{t('start.subtitle', { title: task.item.title, stage: task.stage })}</DialogDescription>}
    </DialogHeader>
  );
}

// The preparing view of the dialog's request (#390): the server's rows, and the session row the dialog's own picks name
function Preparing({ progress, view, mode, agent, stage, onClose, onRetry }: { progress: SetupRows; view: SetupView; mode: StartMode; agent: string; stage: string; onClose(): void; onRetry(): void }) {
  const text = mode === 'stages' ? t('setupProgress.session.stage', { agent, stage }) : t('setupProgress.session.free', { agent });
  return <SetupProgressView progress={progress} isLive={view.isLive} isFailed={view.isFailed} session={{ text, status: sessionStatus(progress.rows, view.isAnswered) }} onClose={onClose} onRetry={onRetry} />;
}

/** The Start dialog (redesign 11): Iniciar #id from a task's iniciar, abrir sessão and executar etapas… (2a, 2b), or Nova atividade from the
 * activities' +, ⌘N and the home (2c), where the task is picked or created in the Hive; then executar etapas or sessão livre, the base with
 * the stacked-PR and local switches while the task has no worktree, and the stages box or the agent and session. the confirm key submits and switchStartMode flips the mode (#585). A task created
 * here and never started is removed on the way out, so a cancel leaves nothing behind. Once its request's task is marked as preparing its
 * worktree (#390), the dialog shows the preparing view until the request ends. */
export function StartDialog(props: StartDialogProps) {
  const { state, taskId } = props;
  const id = useId();
  const { task, picked, mode, setMode, run, error, pending, isCreating, base, isBlocked, pick, create, close, submit, choices, held, view } = useStart(props);
  const progress = task && view.progress;
  const stagesOff = task === undefined || hasStagesToRun(task.stage, state.stages) ? undefined : t('start.noStages', { stage: task.stage });
  // #316: the lists of the workspace the run goes in: the task's, else the one the base field picked
  const runWorkspace = (task && resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks)) ?? base.choice.workspace;
  // #774: a pick with nothing to run lands on sessão livre; any other pick leaves the mode where the user put it
  const pickTask = (itemId: string): void => { pick(itemId); if (nothingToRun(state, itemId)) setMode('free'); };
  // confirm starts (#585: was a fixed ⌘↵), switchStartMode flips the mode; both read their binding at each key
  const onKeyDown = (e: KeyboardEvent): void => {
    const next = progress ? undefined : modeAfterKey(e.nativeEvent, mode, stagesOff !== undefined); // #390: the preparing view has no mode
    if (!pressed(e.nativeEvent, 'confirm') && next === undefined) return;
    e.preventDefault();
    if (next === undefined) submit();
    else setMode(next);
  };
  const label = t(mode === 'stages' ? 'start.mode.stages' : 'start.mode.free');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      {/* #774: DialogContent is a grid; with min-width auto a nowrap title sets the column's width and pushes every field past the edge */}
      <DialogContent className="gap-[18px] sm:max-w-[480px] *:min-w-0" onKeyDown={onKeyDown} aria-describedby={task && (taskId !== undefined || progress) ? `${id}-sub` : undefined}>
        <StartHeader id={id} task={task} isNew={taskId === undefined} isPreparing={progress !== undefined} />
        {progress && task ? <Preparing progress={progress} view={view} mode={mode} agent={run.picks.agent} stage={task.stage} onClose={close} onRetry={submit} /> : (
          <>
            {taskId === undefined && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-task`}>{t('start.task')}</Label>
                <TaskPicker id={`${id}-task`} tasks={pickable(state)} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} value={picked} destinations={choices} heldLabel={held && t('start.held', { title: held.title, source: held.source })} onPick={pickTask} onCreate={create} />
              </div>
            )}
            <ModeToggle mode={mode} stagesOff={stagesOff} onChange={setMode} />
            <BaseField id={id} mode={mode} choice={base.choice} workspaces={state.workspaces} onChange={base.setChoice} onWorkspace={base.pickWorkspace} />
            <RunSection id={id} mode={mode} task={task} state={state} run={run} workspace={runWorkspace} />
            {error && <p role="alert" className="whitespace-pre-line text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={isCreating} onClick={close}>{t('base.cancel')}</Button>
              <SetupSubmit label={<>{label}<ButtonKeyHint id="confirm" /></>} pending={pending} setup={task && activityOf(state, task.item.itemId)?.setup} disabled={isBlocked} onSubmit={submit} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
