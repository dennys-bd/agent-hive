import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { setLanguage } from '@/i18n';
import { ALL_AGENTS } from '../../src/agents';
import type { AgentAvailability, AgentId, LaunchOptions } from '../../src/types';
import { bareTask, liveOf, taskPairOf, type WithWork } from '../fixtures/work';

// #257: the dialog of the handoff's section 2, rendered on its own; the + and the key that open it are NewRunButton's (Task 6)
const task: WithWork = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, worktree: '/wt/hive-1-task-1', branch: 'hive/1-task-1' };
const target = { kind: 'task' as const, task: bareTask(task), activity: taskPairOf('I1', liveOf(task)).activity };
const OPTIONS: LaunchOptions = {
  claude: {
    aliases: [{ id: 'opus', hint: 'opus 5.5' }, { id: 'opus[1m]' }], versions: [{ id: 'claude-opus-5-5' }],
    specializedAgents: [{ name: 'hive:designer', description: 'Designs the interface' }, { name: 'hive:planner', description: 'Writes the plan' }],
    args: ['--permission-mode', 'auto'],
  },
  codex: { aliases: [], versions: [{ id: 'gpt-5.6-terra', hint: 'GPT-5.6 Terra' }], specializedAgents: [{ name: 'hive:designer', description: 'Designs the interface' }], args: [] },
};
const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_path: string) => answer(OPTIONS));
const onOpen = vi.fn();
const onClose = vi.fn();
const shown = (defaultAgent: AgentId = 'claude', agents: readonly AgentAvailability[] = ALL_AGENTS) =>
  render(<NewSessionDialog target={target} defaultAgent={defaultAgent} agents={agents} onOpen={onOpen} onClose={onClose} />);
const listbox = (): HTMLElement => screen.getByRole('listbox');

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockClear();
  onOpen.mockClear();
  onClose.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('the dialog reads /launch-options as it opens, names the task and its branch, and Enter with no change opens the default agent with no picks (#257)', async () => {
  const user = userEvent.setup();
  shown();
  expect(screen.getByRole('dialog', { name: 'Nova sessão' })).toBeInTheDocument();
  expect(screen.getByText('#1 Task 1')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/launch-options');
  expect(await screen.findByText('claude --permission-mode auto')).toBeInTheDocument(); // runs: the global args once they came
  expect(screen.getByText('hive/1-task-1')).toBeInTheDocument(); // in: the branch
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledWith('claude', {});
  expect(onClose).toHaveBeenCalled();
});

test('a picked model, specialized agent and arguments reach the open, and the runs line follows them (#257)', async () => {
  const user = userEvent.setup();
  shown();
  await screen.findByText('claude --permission-mode auto');
  await user.click(screen.getByRole('combobox', { name: 'modelo' }));
  expect(within(listbox()).getByText('com contexto de 1M')).toBeInTheDocument(); // opus[1m]'s hint, in the page's language
  await user.click(within(listbox()).getByText('opus'));
  await user.click(screen.getByRole('combobox', { name: 'agente especializado' }));
  await user.click(within(listbox()).getByText('hive:designer'));
  await user.type(screen.getByLabelText('argumentos'), '--verbose  --debug');
  expect(screen.getByText('claude --permission-mode auto --verbose --debug --agent hive:designer --model opus')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^abrir sessão/ }));
  expect(onOpen).toHaveBeenCalledWith('claude', { model: 'opus', specializedAgent: 'hive:designer', args: ['--verbose', '--debug'] });
});

test('a model the lists lack is offered as typed and opens as typed (#257)', async () => {
  const user = userEvent.setup();
  shown();
  await user.click(screen.getByRole('combobox', { name: 'modelo' }));
  await user.type(screen.getByRole('combobox', { name: 'buscar modelo' }), 'claude-opus-4-1');
  await user.click(within(listbox()).getByText('usar "claude-opus-4-1"'));
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledWith('claude', { model: 'claude-opus-4-1' });
});

test('on codex the model goes behind -m and the emulated specialized agent shows no flag (#257)', async () => {
  const user = userEvent.setup();
  shown('codex');
  await user.click(screen.getByRole('combobox', { name: 'modelo' }));
  await user.click(await within(listbox()).findByText('gpt-5.6-terra'));
  await user.click(screen.getByRole('combobox', { name: 'agente especializado' }));
  await user.click(within(listbox()).getByText('hive:designer'));
  expect(screen.getByText('codex -m gpt-5.6-terra')).toBeInTheDocument();
});

test('Esc closes the dialog without opening anything; an agent boot did not find opens nothing (#257)', async () => {
  const user = userEvent.setup();
  const { unmount } = shown();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
  unmount();
  shown('claude', [{ agent: 'claude', available: false }, { agent: 'codex', available: true }]);
  expect(screen.getByRole('button', { name: /^abrir sessão/ })).toBeDisabled();
  await user.keyboard('{Enter}');
  expect(onOpen).not.toHaveBeenCalled();
});

test('a failed /launch-options leaves the fields usable with the defaults (#257)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } }));
  shown();
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledWith('claude', {});
});
