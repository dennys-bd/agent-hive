import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SleepButton } from '@/components/SleepButton';
import { setLanguage, statusText } from '@/i18n';
import { type Activity, activitiesOf } from '@/lib/activities';
import type { Terminal, Worker } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// sonner is mocked so the sleep notice is observable
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }) }));

const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt' };
const STAGE: Worker = { id: 's1', status: 'working', activityId: activityIdOf('I1'), runId: 'W1', sessionId: 'aaaaaaaa1111' };
const SESSION: Worker = { id: 's2', status: 'waiting', activityId: activityIdOf('I1'), runId: 'W2', sessionId: 'bbbbbbbb2222', freeSession: true };
const SHELL: Terminal = { terminalId: 'W3', activityId: activityIdOf('I1'), startedAt: '2026-09-29T10:00:00.000Z', cwd: '/repo' };
// What the bar hands it: the task's activity, its live runs a run command's left out
function activityWith(workers: Worker[], terminals: Terminal[]): Activity {
  const [own] = activitiesOf(withPointedWork({ tasks: [task], workers, terminals, workspaces: [], activities: [], activityRecords: [] }));
  if (own === undefined) throw new Error('the task is an activity');
  return own;
}
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const posts = (): string[] => fetchMock.mock.calls.flatMap((call) => {
  const [url, init] = call as unknown as [string, RequestInit | undefined];
  return init?.method === 'POST' ? [url] : [];
});
const bodyOf = (path: string): unknown => {
  const call = fetchMock.mock.calls.find((c) => (c as unknown[])[0] === path) as unknown[] | undefined;
  return call === undefined ? undefined : JSON.parse(String((call[1] as RequestInit).body));
};
const chevron = (): HTMLElement => screen.getByRole('button', { name: 'escolher a sessão para dormir' });

// Radix's DropdownMenu opens from the keyboard under jsdom, as the + test does (#292)
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
  chevron().focus();
  await user.keyboard('{Enter}');
  return screen.findAllByRole('menuitem');
}

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockClear();
  vi.mocked(toast.custom).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('dormir sleeps the focused agent session at once, with no dialog, and shows the sleep notice; the split button is outline, never destructive (#672)', async () => {
  const user = userEvent.setup();
  render(<SleepButton activity={activityWith([STAGE, SESSION], [SHELL])} focusedRun="W2" />);
  const main = screen.getByRole('button', { name: 'dormir' });
  expect(main).not.toHaveClass('bg-destructive');
  expect(chevron()).not.toHaveClass('bg-destructive');
  await user.click(main);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => expect(posts()).toEqual(['/ptys/W2/stop']));
  await waitFor(() => expect(toast.custom).toHaveBeenCalledTimes(1));
});

test('a focused terminal sleeps as its tab\'s close does: dormir, outline, at once with no agent in it; with no focused run the button is disabled (#696)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<SleepButton activity={activityWith([STAGE], [SHELL])} focusedRun="W3" />);
  const main = screen.getByRole('button', { name: 'dormir' });
  expect(main).not.toHaveClass('bg-destructive');
  await user.click(main);
  await waitFor(() => expect(posts()).toEqual(['/ptys/W3/stop']));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  rerender(<SleepButton activity={activityWith([STAGE], [SHELL])} focusedRun={undefined} />);
  expect(screen.getByRole('button', { name: 'dormir' })).toBeDisabled();
});

test('a focused terminal running an agent the shim missed asks the agent confirm before it sleeps (#696)', async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') seen.push(url);
    return new Response(JSON.stringify(String(url).endsWith('/agents') ? { agents: ['claude'] } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<SleepButton activity={activityWith([STAGE], [SHELL])} focusedRun="W3" />);
  await user.click(screen.getByRole('button', { name: 'dormir' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('um agente que o Hive não capturou executa num terminal: a conversa dele se perde quando o terminal dorme.');
  expect(dialog).toHaveAccessibleName('Dormir sessão');
  expect(within(dialog).getByText('Terminal · #1 Task 1')).toHaveClass('font-mono');
  expect(seen).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'dormir' }));
  await waitFor(() => expect(seen).toEqual(['/ptys/W3/stop']));
});

test('the ⌄ lists the agent sessions only, under sessões ativas · 2, em foco on the focused one; a pick sleeps it at once (#536, #672)', async () => {
  const user = userEvent.setup();
  render(<SleepButton activity={activityWith([STAGE, SESSION], [SHELL])} focusedRun="W2" />);
  const items = await openMenu(user);
  expect(screen.getByText('sessões ativas · 2')).toBeInTheDocument();
  expect(items.map((i) => i.textContent)).toEqual(['claudeaaaaaaaa', 'claudebbbbbbbbem foco', 'dormir todasCtrl+Alt+Shift+.']);
  expect(items[2]).not.toHaveClass('text-destructive');
  await user.click(items[0]);
  await waitFor(() => expect(posts()).toEqual(['/ptys/W1/stop']));
});

test('dormir todas opens the dialog listing each session with its status and each terminal; confirming posts one sleep for all of them and shows one notice (#672, #696)', async () => {
  const user = userEvent.setup();
  render(<SleepButton activity={activityWith([STAGE, SESSION], [SHELL])} focusedRun="W3" />);
  await openMenu(user);
  await user.click(screen.getByRole('menuitem', { name: /^dormir todas/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Dormir #1 Task 1?' });
  expect(dialog).toHaveTextContent('cada sessão para no ponto em que está e pode ser continuada depois; cada terminal dorme com a sua saída e acorda onde estava.');
  expect(within(dialog).getByText('aaaaaaaa')).toHaveClass('font-mono');
  expect(within(dialog).getByText(statusText('working'))).toBeInTheDocument();
  expect(within(dialog).getByText('Terminal')).toBeInTheDocument();
  expect(posts()).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'dormir todas' }));
  await waitFor(() => expect(bodyOf('/ptys/sleep')).toEqual({ ptyIds: ['W1', 'W2', 'W3'] }));
  await waitFor(() => expect(toast.custom).toHaveBeenCalledTimes(1));
});

test('an agent the shim missed in one of the terminals adds the lost-conversation line to the dialog (#696)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/agents') ? { agents: ['claude'] } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<SleepButton activity={activityWith([STAGE], [SHELL])} focusedRun="W1" />);
  await openMenu(user);
  await user.click(screen.getByRole('menuitem', { name: /^dormir todas/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Dormir #1 Task 1?' });
  await waitFor(() => expect(dialog).toHaveTextContent('um agente que o Hive não capturou executa num terminal: a conversa dele se perde quando o terminal dorme.'));
});

test('Ctrl+Shift+. sleeps the focused session at once; on a focused terminal it does nothing (#585, #672)', async () => {
  const sleepOne = (): boolean => fireEvent.keyDown(document.body, { key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
  const { rerender } = render(<SleepButton activity={activityWith([STAGE, SESSION], [SHELL])} focusedRun="W3" />);
  sleepOne();
  expect(posts()).toEqual([]);
  rerender(<SleepButton activity={activityWith([STAGE, SESSION], [SHELL])} focusedRun="W2" />);
  sleepOne();
  await waitFor(() => expect(posts()).toEqual(['/ptys/W2/stop']));
});

test('Ctrl+Alt+Shift+. sleeps a single session at once and opens dormir todas\' dialog on several runs or a terminal (#585, #672, #696)', async () => {
  const sleepAll = (): void => { fireEvent.keyDown(document.body, { key: '>', code: 'Period', ctrlKey: true, altKey: true, shiftKey: true }); };
  const { rerender } = render(<SleepButton activity={activityWith([STAGE], [])} focusedRun="W1" />);
  sleepAll();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(bodyOf('/ptys/sleep')).toEqual({ ptyIds: ['W1'] }));
  rerender(<SleepButton activity={activityWith([], [SHELL])} focusedRun="W3" />);
  sleepAll();
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});

test('a task waiting for CI: the bar\'s dormir ends the wait with no run focused; dormir todas ends it beside the runs (#834)', async () => {
  const user = userEvent.setup();
  const waiting: WithWork = { ...task, ci: { stage: 'ci', since: '2026-10-07T10:00:00.000Z', reran: [] } };
  const of = (terminals: Terminal[]): Activity => {
    const [own] = activitiesOf(withPointedWork({ tasks: [waiting], workers: [], terminals, workspaces: [], activities: [], activityRecords: [] }));
    if (own === undefined) throw new Error('the waiting task is an activity');
    return own;
  };
  const stopPath = `/activities/${activityIdOf('I1')}/ci/stop`;
  const { unmount } = render(<SleepButton activity={of([])} />);
  expect(chevron()).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'dormir' }));
  await waitFor(() => expect(posts()).toEqual([stopPath]));
  expect(toast.custom).not.toHaveBeenCalled(); // no session slept
  unmount();
  fetchMock.mockClear();
  render(<SleepButton activity={of([SHELL])} />);
  await user.click((await openMenu(user)).find((item) => item.textContent?.startsWith('dormir todas'))!);
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /dormir todas/ }));
  await waitFor(() => expect(posts().sort()).toEqual(['/ptys/sleep', stopPath].sort()));
  expect(bodyOf('/ptys/sleep')).toEqual({ ptyIds: ['W3'] });
});
