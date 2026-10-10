// The flow's keys on a focused task (#585): the arrows move the focus between tasks, Enter opens its details as a click does, F opens them on
// the feedback box with the cursor in it, O opens the activity, and the other letters run the task menu's own item. A key whose item is disabled or absent
// does nothing and lets the key go on. Only on the task's own element: a key inside a field, a button or a dialog it opened (portaled, yet
// bubbling through React) is not the task's.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { activityOf } from '../../activities';
import { canOpenSession } from '../../tasks';
import type { State, Task } from '../../types';
import { act } from '@/components/actions';
import { requestFeedback } from '@/components/ApprovalActions';
import type { StartMode } from '@/components/StartFields';
import { isMac } from '@/lib/shortcut-bindings';
import { answerableActivity, createsIssues } from '@/lib/task-state';

type Direction = 'up' | 'down' | 'left' | 'right';
export type TaskLetter = 'runStages' | 'freeSession' | 'approve' | 'feedback' | 'openActivity' | 'autoTask' | 'taskMenu';
type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'code'>>;

const ARROWS: Readonly<Record<string, Direction>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
// The map's flow rows (#585): the fixed keys of a focused task
const LETTERS: Readonly<Record<string, TaskLetter>> = { i: 'runStages', l: 'freeSession', a: 'approve', f: 'feedback', o: 'openActivity', s: 'autoTask', m: 'taskMenu' };
const TASK = '[data-task-id]';
const STAGE = '[data-stage-tasks]';

const isBare = (e: KeyPress): boolean => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
const isOwn = (e: ReactKeyboardEvent<HTMLElement>): boolean => e.target === e.currentTarget;
// The letter from the key's position, as keyOf does in shortcuts.ts: on a non-Latin layout `key` is another script's letter. A synthetic event
// without a code falls back to `key`
const letterKey = (e: KeyPress): string => (/^Key([A-Z])$/.exec(e.code ?? '')?.[1] ?? e.key).toLowerCase();

/** Which task key a keydown is (#585): a bare letter, or Shift+F10 for the menu off macOS, as Linux and Windows open a context menu. */
export function letterOf(e: KeyPress, mac: boolean): TaskLetter | undefined {
  if (!mac && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'F10') return 'taskMenu';
  return isBare(e) && Object.hasOwn(LETTERS, letterKey(e)) ? LETTERS[letterKey(e)] : undefined;
}

const tasksOf = (stage: Element): HTMLElement[] => [...stage.querySelectorAll<HTMLElement>(TASK)];
const middle = (el: Element): number => {
  const rect = el.getBoundingClientRect();
  return rect.top + rect.height / 2;
};

/** Where an arrow takes the focus from `from` (#585): ↑↓ the previous or next task of its stage; ←→ the task nearest its vertical middle in
 * the closest stage that has one (an empty stage is skipped, ties go to the first). undefined at an edge. */
export function neighbourTask(from: HTMLElement, direction: Direction): HTMLElement | undefined {
  const stage = from.closest(STAGE);
  const flow = from.closest('[data-flow-stages]');
  if (stage === null || flow === null) return undefined;
  if (direction === 'up' || direction === 'down') {
    const tasks = tasksOf(stage);
    return tasks[tasks.indexOf(from) + (direction === 'down' ? 1 : -1)];
  }
  const stages = [...flow.querySelectorAll(STAGE)];
  const at = stages.indexOf(stage);
  const ahead = direction === 'right' ? stages.slice(at + 1) : stages.slice(0, at).reverse();
  const next = ahead.find((c) => tasksOf(c).length > 0);
  if (next === undefined) return undefined;
  const y = middle(from);
  return tasksOf(next).reduce((best, t) => (Math.abs(middle(t) - y) < Math.abs(middle(best) - y) ? t : best));
}

// F (#585): the details, with the cursor in the band's feedback box. Only while the approval is the user's to answer: the menu's own rule for
// enviar feedback… (#268, #685, #829)
function feedbackAction(task: Task, state: State, onOpen?: (taskId: string) => void): (() => void) | undefined {
  if (onOpen === undefined || answerableActivity(task, state) === undefined) return undefined;
  return () => {
    requestFeedback(task.item.itemId);
    onOpen(task.item.itemId);
  };
}

interface NavArgs { task: Task; state: State; onOpen?(taskId: string): void; openActivity?(): void }

// What a key on the task's own element runs: an arrow's move, Enter's open, F's feedback, O's activity; undefined for any other key
function navAction(e: ReactKeyboardEvent<HTMLElement>, { task, state, onOpen, openActivity }: NavArgs): (() => void) | undefined {
  const target = e.currentTarget;
  if (isBare(e) && Object.hasOwn(ARROWS, e.key)) return () => neighbourTask(target, ARROWS[e.key])?.focus();
  if (isBare(e) && e.key === 'Enter') return onOpen && (() => onOpen(task.item.itemId));
  const letter = letterOf(e, isMac());
  if (letter === 'feedback') return feedbackAction(task, state, onOpen);
  return letter === 'openActivity' ? openActivity : undefined;
}

/** The keys of a task's own element (#585): the arrows, Enter and F (onOpen, the click's, shows its details) and O (openActivity). */
export function useTaskNavKeys(task: Task, state: State, onOpen?: (taskId: string) => void, openActivity?: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>): void => {
    const run = isOwn(e) ? navAction(e, { task, state, onOpen, openActivity }) : undefined;
    if (run === undefined) return;
    e.preventDefault();
    run();
  };
}

/** What the task menu's letters open (#585): the menu's own Start dialog; the decomposition's confirm (#865), A's while criar issues
 * replaces aprovar. */
export interface TaskMenuOpeners { start(mode: StartMode): void; decomposition(): void }

// The right-click menu from the keyboard (#585): Radix's trigger opens on a contextmenu event, at its point
function openMenuAt(target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
}

/** The task menu's letters on its trigger (#585), each the item the menu itself offers now: executar etapas… and abrir sessão livre… while
 * canOpenSession allows them, aprovar while the approval is the user's to answer (#268, #829), começar sozinho, and the menu. */
export function useTaskMenuKeys(task: Task, state: State, open: TaskMenuOpeners) {
  const path = `/tasks/${encodeURIComponent(task.item.itemId)}`;
  const activity = activityOf(state, task.item.itemId);
  const answerable = answerableActivity(task, state);
  const items: Partial<Record<TaskLetter, () => void>> = {
    runStages: canOpenSession(task, activity) ? () => open.start('stages') : undefined,
    freeSession: canOpenSession(task, activity) ? () => open.start('free') : undefined,
    // #865: while the stage's decomposition is not on GitHub, A opens criar issues' confirm, as the detail's button does
    approve: answerable === undefined ? undefined : createsIssues(task, state) ? () => open.decomposition() : () => void act(`/activities/${encodeURIComponent(answerable.id)}/approve`),
    autoTask: () => void act(`${path}/auto`, { auto: !task.auto }),
  };
  return (e: ReactKeyboardEvent<HTMLElement>): void => {
    const letter = isOwn(e) ? letterOf(e, isMac()) : undefined;
    const target = e.currentTarget;
    const run = letter === 'taskMenu' ? () => openMenuAt(target) : letter === undefined ? undefined : items[letter];
    if (run === undefined) return;
    e.preventDefault();
    run();
  };
}
