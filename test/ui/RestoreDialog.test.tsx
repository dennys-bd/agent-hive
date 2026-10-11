import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RestoreDialog } from '@/components/RestoreDialog';
import { setLanguage } from '@/i18n';
import type { Checkpoint, Task } from '../../src/types';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply({ ok: true }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const task: Task = { item: { itemId: 'I1', id: '480', title: 'A hung daemon', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true };
const CHECKPOINT: Checkpoint = { n: 3, stage: 'dev', start: 'a'.repeat(40), head: 'a'.repeat(40), commit: 'b'.repeat(40), branch: 'hive/480-x', at: '2026-10-10T10:00:00.000Z', ended: 'restart' };
const PATH = '/activities/a-I1/checkpoints/3/restore';

test('reset mode: the title, the lead and the kept line, no published-branch sentence; restaurar posts and closes (#619)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  fetchMock.mockImplementationOnce(async () => reply({ mode: 'reset', branch: 'hive/480-x' }));
  render(<RestoreDialog task={task} activityId="a-I1" checkpoint={CHECKPOINT} onClose={onClose} />);
  const dialog = await screen.findByRole('dialog', { name: 'Restaurar ponto 3 de dev' });
  expect(within(dialog).getByText('o estado atual é guardado antes como um ponto de restauração.')).toBeInTheDocument();
  expect(within(dialog).queryByText(/já foi publicado/)).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(PATH);
  const confirm = within(dialog).getByRole('button', { name: 'restaurar' });
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenLastCalledWith(PATH, expect.objectContaining({ method: 'POST' }));
});

test('branch mode says the published branch stays; a failure shows the dialog\'s own message, never git\'s words, and keeps it open (#619)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  fetchMock.mockImplementationOnce(async () => reply({ mode: 'branch', branch: 'hive/480-x', newBranch: 'hive/480-x-r2' }));
  fetchMock.mockImplementationOnce(async () => reply({ error: 'fatal: boom' }, 500));
  render(<RestoreDialog task={task} activityId="a-I1" checkpoint={CHECKPOINT} onClose={onClose} />);
  expect(await screen.findByText('O branch hive/480-x já foi publicado e fica como está; a etapa recomeça no novo branch hive/480-x-r2.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'restaurar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('a restauração não pôde ser executada.');
  expect(screen.queryByText(/fatal: boom/)).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
