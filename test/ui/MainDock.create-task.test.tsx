import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowHeader } from '@/components/FlowHeader';
import { MainDock } from '@/components/MainDock';
import { setLanguage } from '@/i18n';
import { stateOf } from './search-fixtures';
import { FakeWebSocket, resetFakes } from './xterm-fakes';
import { localPairs, withPointedWork, type WithWork } from '../fixtures/work';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

const WORKSPACES = ['hive', 'site'];
// #774: task A's activity lives in site, so the dialog's workspace says which one ⌘P passed
const taskA: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/w/a', workspace: 'site' };
const onSelect = vi.fn();

function Home({ flow = <main>fluxo</main> }: { flow?: ReactNode }) {
  const work = withPointedWork({ tasks: [taskA], workers: [], terminals: [], ...localPairs(WORKSPACES) });
  return (
    <MainDock
      fileLinks={false} fontFamily="ui-monospace, monospace" workspaces={WORKSPACES} tasks={[taskA]} workers={[]} terminals={[]}
      liveActivities={work.activities} activityRecords={work.activityRecords} flows={[]} sourceWorkspaces={{}}
      search={{ state: stateOf([taskA], { workspaces: WORKSPACES }) }} newActivity={(start) => <p>{`start:${start.title ?? ''}`}</p>}
      onSelect={onSelect} detail={() => <p>detalhes</p>} automation={() => <p>automação</p>} header={() => <header />}
    >
      {flow}
    </MainDock>
  );
}

const searchKey = (): void => { fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }); }; // search off macOS (#585)
const posts = (): string[] => vi.mocked(fetch).mock.calls
  .filter(([url, init]) => init?.method === 'POST' && !String(url).startsWith('/view-state/')).map(([url]) => String(url));
// The search on tarefas with no result, then its first row: the create-task dialog
async function createFromSearch(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  searchKey();
  await user.keyboard('#zzqq'); // # switches to tarefas
  await user.click(screen.getByRole('option', { name: '+ criar tarefa "zzqq"' }));
  return screen.findByRole('alertdialog', { name: 'Criar tarefa' });
}
const showActivity = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'atividades' }));
  await user.click(screen.getByRole('button', { name: /#1 Task A/ }));
};

beforeEach(() => {
  setLanguage('pt');
  localStorage.clear();
  resetFakes();
  onSelect.mockClear();
  vi.mocked(toast).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/tasks' ? { id: 'T9' } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

test('⌘P\'s + criar tarefa opens the create-task dialog with the term and the shown activity\'s workspace; nothing posts and the Start dialog stays closed (#774)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  await showActivity(user);
  const dialog = await createFromSearch(user);
  expect(within(dialog).getByLabelText('título')).toHaveValue('zzqq');
  expect(within(dialog).getByRole('combobox', { name: 'workspace' })).toHaveTextContent('site');
  expect(within(dialog).getByText('só cria a tarefa, sem iniciar atividade')).toBeInTheDocument(); // no source: no table named
  expect(screen.queryByText(/^start:/)).not.toBeInTheDocument();
  expect(posts()).not.toContain('/tasks');
});

test('under Automação ⌘P\'s + criar tarefa opens the dialog with no workspace (#774, decision 6)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: 'tarefas' })); // the board is the center (#746)
  const dialog = await createFromSearch(user);
  expect(within(dialog).getByRole('combobox', { name: 'workspace' })).toHaveTextContent('escolha um workspace');
});

test('the toast\'s abrir shows the new task in the flow (#774, decision 10)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  await showActivity(user);
  const dialog = await createFromSearch(user);
  await user.click(within(dialog).getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(posts()).toContain('/tasks'));
  const [, options] = vi.mocked(toast).mock.calls.at(-1) as unknown as [string, { action: { onClick(): void } }];
  options.action.onClick();
  expect(onSelect).toHaveBeenLastCalledWith({ taskId: 'T9' });
});

test('the hive source header\'s + criar tarefa opens the dock\'s create-task dialog, empty, naming the hive table (#774)', async () => {
  const user = userEvent.setup();
  render(<Home flow={<FlowHeader state={stateOf([taskA], { workspaces: WORKSPACES })} mode={{ kind: 'source', source: 'hive' }} />} />);
  fireEvent.click(screen.getByRole('button', { name: 'tarefas' })); // the flow is the center
  await user.click(within(screen.getByRole('region', { name: 'tarefas' })).getByRole('button', { name: '+ criar tarefa' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Criar tarefa' });
  expect(within(dialog).getByLabelText('título')).toHaveValue('');
  expect(within(dialog).getByText('só cria a tarefa, sem iniciar atividade · da tabela de hive')).toBeInTheDocument();
  expect(posts()).not.toContain('/tasks');
});
