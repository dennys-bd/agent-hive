import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { movedWork, type WithWork } from '../fixtures/work';

// Its own file (#268, #379), like TaskMenu.approval.test.tsx: Radix's ContextMenu (and any Dialog it opens) shows content only once per
// jsdom file, so the menu opens exactly once and every further state — the dialog switching Enviar to Começar agora/Fila, a failed then a
// successful send — is reached through one open dialog and `rerender`.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}', approval: true }];
const task = (extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const workers: Worker[] = [{ id: 's1', status: 'empty' }];
const state = (c: WithWork): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers, terminals: [], stages, tasks: [c], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });

test('Enviar feedback… opens a feedback dialog beside the menu (#379): Enviar on a held session, Começar agora/Fila without one, a failed send keeps it open with the text and an inline error, a successful one closes it', async () => {
  const user = userEvent.setup();
  const held = task({ approval: { since: '2026-09-25T10:00:00.000Z', until: '2026-09-25T10:05:00.000Z' } });
  const { rerender } = render(<Flow state={state(held)} />);
  fireEvent.contextMenu(screen.getByText('#1 Task 1').closest('li')!);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'enviar feedback…' }));
  const dialog = await screen.findByRole('dialog', { name: 'enviar feedback…' });
  expect(within(dialog).getByRole('button', { name: 'enviar' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'começar agora' })).not.toBeInTheDocument();

  const noSession = task({ approval: { since: '2026-09-25T10:00:00.000Z' } });
  rerender(<Flow state={state(noSession)} />);
  expect(within(dialog).queryByRole('button', { name: 'enviar' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'começar agora' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'na ordem' })).toBeInTheDocument();

  await user.type(within(dialog).getByLabelText('Feedback'), 'split the spec');
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'deu ruim' }), { status: 500, headers: { 'content-type': 'application/json' } }));
  await user.click(within(dialog).getByRole('button', { name: 'na ordem' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ text: 'split the spec', start: false }),
  })));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('deu ruim');
  expect(within(dialog).getByLabelText('Feedback')).toHaveValue('split the spec');
  expect(screen.getByRole('dialog', { name: 'enviar feedback…' })).toBeInTheDocument();

  await user.click(within(dialog).getByRole('button', { name: 'começar agora' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/feedback', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ text: 'split the spec', start: true }),
  })));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'enviar feedback…' })).not.toBeInTheDocument());
});
