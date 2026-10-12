import { type KeyboardEvent, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { activityOf, workIdOf } from '../../activities';
import { startMode } from '../../task-runs';
import { canOpenSession, defaultSession, HIVE_SOURCE, stageOf } from '../../tasks';
import type { AgentId, Task, OpenResult, State } from '../../types';
import { act, attachRun } from '@/components/actions';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { TaskPicker } from '@/components/TaskPicker';
import { SetupSubmit } from '@/components/SetupProgress';
import { ButtonKeyHint } from '@/components/KeyHint';
import { BaseField, FreeFields, modeAfterKey, ModeToggle, NEW_SESSION, StagesBox, type StartMode } from '@/components/StartFields';
import { useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { usePendingTask, useAutoStart } from '@/hooks/use-pending-task';
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

// executar etapas: the stage's start with the base chosen, or its continue once the stage already ran (#283). A task this dialog created
// was created with auto off, so the fill left it alone until now; the start taken, it becomes a task like any other and the flow goes on (redesign 11)
async function runStages(task: Task, state: State, base: BaseChoice, created: boolean): Promise<void> {
  const path = taskPath(task.item.itemId);
  const work = workIdOf(state, task.item.itemId); // the live activity, else a deleted one's record whose session the continue resumes (#629)
  const mode = startMode(task, state);
  if (typeof mode === 'object' && mode.continue && work !== undefined) await postJson(`/activities/${encodeURIComponent(work)}/continue`, { size: shownSize() }); // #812: after a free run, a start
  else await postJson(`${path}/start`, { ...baseBody(base), size: shownSize() });
  if (created) await act(`${path}/auto`, { auto: true });
}

// sessão livre: the agent opened on the task with no prompt (#925: the field's agent, the default preselected), a new session or a resumed one. The caller attaches the run it answers,
// unless the dialog closed meanwhile (#351)
function openFree(task: Task, base: BaseChoice, session: string, agent: AgentId): Promise<OpenResult> {
  const body = { kind: agent, ...(session === NEW_SESSION ? {} : { continueId: session }), ...baseBody(base), size: shownSize() };
  return postJson<OpenResult>(`${taskPath(task.item.itemId)}/open`, body);
}

// The session a task preselects: the one its stage's session policy would resume on a normal start (#237), else a new one
function initialSession(state: State, itemId: string | undefined): string {
  const task = state.tasks.find((c) => c.item.itemId === itemId);
  return task === undefined ? NEW_SESSION : (defaultSession(task, state, stageOf(state.stages, task.stage)) ?? NEW_SESSION);
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

// The pick (or the task created here), the mode and the session that follow it
function useTaskPick(state: State, taskId: string | undefined, initialMode: StartMode, setError: (message: string | undefined) => void) {
  const [picked, setPicked] = useState(taskId);
  const [mode, setMode] = useState<StartMode>(() => (nothingToRun(state, taskId) ? 'free' : initialMode)); // #774: not an effect, no frame on stages
  const [session, setSession] = useState(() => initialSession(state, taskId));
  const defaultAgent = useContext(DefaultAgentContext); const [agent, setAgent] = useState<AgentId>(defaultAgent);
  const task = state.tasks.find((c) => c.item.itemId === picked);
  const pick = (itemId: string): void => {
    setPicked(itemId);
    setError(undefined);
    setSession(initialSession(state, itemId));
  };
  return { picked, setPicked, mode, setMode, session, setSession, agent, setAgent, pick, task };
}

function useStart({ state, taskId, initialMode = 'stages', workspace, title, onStarted, onActivity, onClose }: StartDialogProps) {
  const openRun = useOpenRun();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [isCreating, setIsCreating] = useState(false); // a source create in flight: closing then would leave its issue behind
  const done = useRef(false); // started or closed: a late answer changes nothing
  const heldIds = useRef(new Set<string>()); // the source tasks the held entry became: created with auto off, like the hive ones
  const onError = useCallback((message: string) => setError(message), []);
  const { picked, setPicked, mode, setMode, session, setSession, agent, setAgent, pick, task } = useTaskPick(state, taskId, initialMode, setError);
  const base = useStartBase(picked, onError);
  const { choices, created, held, create, pickTask } = useCreateRow(state, workspace, done, onError, pick, () => setPicked(undefined));
  useCreateOnOpen(taskId === undefined ? title : undefined, create);
  const isBlocked = held.entry === undefined && blocker(task, state, mode, base.choice);
  const close = (): void => {
    if (isCreating) return;
    // created here and never started: they go. A start on its way (ver log closes too) keeps its task
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
    const run = mode === 'stages' ? runStages(task, state, base.choice, isCreated) : openFree(task, base.choice, session, agent);
    run.then((opened) => {
      if (done.current) return; // closed meanwhile: nothing attaches it, the task carries the session (#351)
      done.current = true;
      created.drop(itemId);
      if (opened) attachRun(opened, task, 'session', openRun); // in the center at once (#249, #491)
      else onStarted?.(itemId);
      onActivity?.(itemId);
      onClose();
    }, (err: Error) => {
      // closed while it was on its way: a task created here that never started goes, as a cancel would have removed it
      if (done.current) { if (isCreated) void act(`${taskPath(itemId)}/close`); return; }
      setPending(false);
      setError(err.message);
    });
  };
  useAutoStart(held.awaiting, task, isBlocked || pending || done.current, () => { held.clearAwaiting(); submit(); });
  return { task, picked, mode, setMode, session, setSession, agent, setAgent, error, pending, isCreating, base, isBlocked, pick: pickTask, create, close, submit, choices, held: held.entry };
}

/** The Start dialog (redesign 11): Iniciar #id from a task's iniciar, abrir sessão and executar etapas… (2a, 2b), or Nova atividade from the
 * activities' +, ⌘N and the home (2c), where the task is picked or created in the Hive; then executar etapas or sessão livre, the base with
 * the stacked-PR and local switches while the task has no worktree, and the stages box or the agent and session. the confirm key submits and switchStartMode flips the mode (#585). A task created
 * here and never started is removed on the way out, so a cancel leaves nothing behind. */
export function StartDialog(props: StartDialogProps) {
  const { state, taskId } = props;
  const id = useId();
  const { task, picked, mode, setMode, session, setSession, agent, setAgent, error, pending, isCreating, base, isBlocked, pick, create, close, submit, choices, held } = useStart(props);
  const stagesOff = task === undefined || hasStagesToRun(task.stage, state.stages) ? undefined : t('start.noStages', { stage: task.stage });
  // #774: a pick with nothing to run lands on sessão livre; any other pick leaves the mode where the user put it
  const pickTask = (itemId: string): void => { pick(itemId); if (nothingToRun(state, itemId)) setMode('free'); };
  // confirm starts (#585: was a fixed ⌘↵), switchStartMode flips the mode; both read their binding at each key
  const onKeyDown = (e: KeyboardEvent): void => {
    const next = modeAfterKey(e.nativeEvent, mode, stagesOff !== undefined);
    if (!pressed(e.nativeEvent, 'confirm') && next === undefined) return;
    e.preventDefault();
    if (next === undefined) submit();
    else setMode(next);
  };
  const label = t(mode === 'stages' ? 'start.mode.stages' : 'start.mode.free');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      {/* #774: DialogContent is a grid; with min-width auto a nowrap title sets the column's width and pushes every field past the edge */}
      <DialogContent className="gap-[18px] sm:max-w-[480px] *:min-w-0" onKeyDown={onKeyDown} aria-describedby={taskId === undefined || task === undefined ? undefined : `${id}-sub`}>
        <DialogHeader>
          <DialogTitle>{taskId === undefined || task === undefined ? t('start.newTitle') : t('start.title', { id: task.item.id })}</DialogTitle>
          {taskId !== undefined && task && <DialogDescription id={`${id}-sub`} className="text-[13px]">{t('start.subtitle', { title: task.item.title, stage: task.stage })}</DialogDescription>}
        </DialogHeader>
        {taskId === undefined && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-task`}>{t('start.task')}</Label>
            <TaskPicker id={`${id}-task`} tasks={pickable(state)} workspaces={state.workspaces} sourceWorkspaces={state.sourceWorkspaces} value={picked} destinations={choices} heldLabel={held && t('start.held', { title: held.title, source: held.source })} onPick={pickTask} onCreate={create} />
          </div>
        )}
        <ModeToggle mode={mode} stagesOff={stagesOff} onChange={setMode} />
        <BaseField id={id} mode={mode} choice={base.choice} workspaces={state.workspaces} onChange={base.setChoice} onWorkspace={base.pickWorkspace} />
        {mode === 'stages' ? <StagesBox task={task} stages={state.stages} /> : <FreeFields id={id} task={task} state={state} session={session} agent={agent} onSession={setSession} onAgent={setAgent} />}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={isCreating} onClick={close}>{t('base.cancel')}</Button>
          <SetupSubmit
            label={<>{label}<ButtonKeyHint id="confirm" /></>}
            pending={pending} setup={task && activityOf(state, task.item.itemId)?.setup} disabled={isBlocked} onSubmit={submit} onOpenLog={close}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
