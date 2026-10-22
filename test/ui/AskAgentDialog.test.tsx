import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AskAgentDialog } from '@/components/benchmark/ask/AskAgentDialog';
import { setLanguage } from '@/i18n';
import { experiment } from '../benchmark/fixtures';
import { jsonResponse } from '../fakes';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const EXPS = [
  experiment({ id: 'exp-1', name: 'Skills', workspace: 'hive' }), experiment({ id: 'exp-2', name: 'Old', workspace: 'hive', archived: true }),
  experiment({ id: 'exp-3', name: 'Site', workspace: 'site' }),
];
let answer = (): Response => jsonResponse({ ok: true });
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? answer() : jsonResponse({}))); // GET: the launch options
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init?.body))]);

beforeEach(() => {
  setLanguage('pt');
  answer = () => jsonResponse({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const open = (onClose = vi.fn()) => {
  render(<AskAgentDialog experiments={EXPS} workspaces={['hive', 'site']} selected={EXPS[0]} onClose={onClose} />);
  return { onClose, dialog: within(screen.getByRole('dialog', { name: 'Novo experimento com o agente' })) };
};

test('criar rascunho is disabled while the description is empty, then posts the description, the workspace, partir de and the agent, and closes (#478)', async () => {
  const user = userEvent.setup();
  const { onClose, dialog } = open();
  const submit = dialog.getByRole('button', { name: /criar rascunho/ });
  expect(submit).toBeDisabled();
  expect(dialog.getByRole('combobox', { name: 'partir de' })).toHaveTextContent('Skills');
  await user.type(dialog.getByRole('textbox', { name: 'o que comparar' }), '  comparar tdd ');
  await user.click(submit);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts()).toEqual([['/benchmark/agent', { description: 'comparar tdd', workspace: 'hive', from: 'exp-1', kind: 'claude' }]]);
});

test('the confirm key submits from the textarea (#478)', async () => {
  const user = userEvent.setup();
  const { onClose, dialog } = open();
  await user.type(dialog.getByRole('textbox', { name: 'o que comparar' }), 'x');
  await user.keyboard('{Control>}{Enter}{/Control}'); // confirm, Ctrl+Enter off macOS (#585)
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(onClose).toHaveBeenCalled();
});

test('a 409 shows the mcpOff toast and keeps the dialog open (#478)', async () => {
  answer = () => jsonResponse({ error: 'mcp_off', message: 'x' }, 409);
  const user = userEvent.setup();
  const { onClose, dialog } = open();
  await user.type(dialog.getByRole('textbox', { name: 'o que comparar' }), 'x');
  await user.click(dialog.getByRole('button', { name: /criar rascunho/ }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ligue benchmark_get e benchmark_draft em Plugins › MCP'));
  expect(onClose).not.toHaveBeenCalled();
});

test("partir de offers nenhum and the workspace's live experiments; another workspace starts on nenhum (#478)", async () => {
  const user = userEvent.setup();
  const { dialog } = open();
  await user.click(dialog.getByRole('combobox', { name: 'workspace' }));
  await user.click(await screen.findByRole('option', { name: 'site' }));
  expect(dialog.getByRole('combobox', { name: 'partir de' })).toHaveTextContent('nenhum');
  await user.click(dialog.getByRole('combobox', { name: 'partir de' }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['nenhum', 'Site']);
});
