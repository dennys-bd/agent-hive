import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useContext } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CreateTaskOpenContext, type CreateTaskRequest, useCreateTaskDialog } from '@/hooks/use-create-task-dialog';
import { setLanguage } from '@/i18n';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }));

// A reader of the context, as the source header is one (#774, decision 11)
function Opener({ request }: { request: CreateTaskRequest }) {
  const open = useContext(CreateTaskOpenContext);
  return <button type="button" onClick={() => open?.(request)}>abrir</button>;
}
function Host({ request }: { request: CreateTaskRequest }) {
  return useCreateTaskDialog({ workspaces: ['hive', 'site'], onOpenTask: vi.fn() }).provide(<Opener request={request} />);
}
const posts = (): unknown[] => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

test('closed until a reader of its context opens it; it opens on what it was asked, posts nothing until its CTA, and closing it unmounts it (#774)', async () => {
  const user = userEvent.setup();
  render(<Host request={{ title: 'Fix login', workspace: 'site', source: 'hive' }} />);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'abrir' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Criar tarefa' });
  expect(within(dialog).getByLabelText('título')).toHaveValue('Fix login');
  expect(within(dialog).getByRole('combobox', { name: 'workspace' })).toHaveTextContent('site');
  expect(within(dialog).getByText('só cria a tarefa, sem iniciar atividade · da tabela de hive')).toBeInTheDocument();
  expect(posts()).toEqual([]);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
});
