import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ResolveDialog } from '@/components/ResolveDialog';
import { RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Session, State } from '../../src/types';
import { AT, fakePrHive, type FakePrHive, prCalls, WITH_TASK } from './pr-harness';

const LIVE = 'aaaaaaaa-1111-4111-8111-111111111111';
const OLD = 'bbbbbbbb-2222-4222-8222-222222222222';
const STOPPED = 'cccccccc-3333-4333-8333-333333333333';
const session = (id: string, agent: Session['agent']): Session => ({ id, startedAt: AT, stages: ['dev'], lastUsedAt: AT, agent });
// Task I1 with sessions OLD, STOPPED (codex) and LIVE, oldest first; LIVE held by the live free run W1
const SESSIONS: State = {
  ...WITH_TASK,
  activityRecords: [{ ...WITH_TASK.activityRecords[0], sessions: [session(OLD, 'claude'), session(STOPPED, 'codex'), session(LIVE, 'claude')] }],
  workers: [{ id: 's1', status: 'working', runId: 'W1', activityId: 'a-I1', freeSession: true, sessionId: LIVE }],
};

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderDialog(state: State = SESSIONS) {
  const openRun = vi.fn();
  const onClose = vi.fn();
  render(<RunOpenerContext.Provider value={openRun}><ResolveDialog task={state.tasks[0]} base="main" state={state} onClose={onClose} /></RunOpenerContext.Provider>);
  return { openRun, onClose, dialog: within(screen.getByRole('alertdialog', { name: 'Resolver o conflito com main' })) };
}

test('lists the live session first and marked, then the stopped ones newest first, then nova sessão; the first is picked (#379)', () => {
  const { dialog } = renderDialog();
  const radios = dialog.getAllByRole('radio');
  expect(radios.map((r) => r.getAttribute('value'))).toEqual([LIVE, STOPPED, OLD, 'new']);
  expect(radios[0]).toBeChecked();
  expect(dialog.getByRole('radio', { name: /aaaaaaaa.*ativa/ })).toBe(radios[0]);
  expect(dialog.getByRole('radio', { name: /cccccccc/ })).toBe(radios[1]);
  expect(dialog.getByRole('radio', { name: 'nova sessão' })).toBe(radios[3]);
});

test('a live session: enviar focuses its run, posts /resolve with the session and the base, and closes (#379)', async () => {
  const user = userEvent.setup();
  const { dialog, openRun, onClose } = renderDialog();
  await user.click(dialog.getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(openRun).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 'W1', task: 'I1' }));
  expect(prCalls(hive, 'POST', '/tasks/I1/resolve')[0]?.body).toEqual({ to: LIVE, promptBase: 'main' });
});

test('a stopped session resumes through /open with its continueId and its own agent (#379)', async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog();
  await user.click(dialog.getByRole('radio', { name: /cccccccc/ }));
  await user.click(dialog.getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', '/tasks/I1/open')[0]?.body).toEqual(expect.objectContaining({ kind: 'codex', continueId: STOPPED, prompt: 'mergeBase', promptBase: 'main' })));
  expect(prCalls(hive, 'POST', '/tasks/I1/resolve')).toHaveLength(0);
});

test('nova sessão opens through /open with the default agent and no continueId, also on a task with no session (#379)', async () => {
  const user = userEvent.setup();
  const { dialog } = renderDialog(WITH_TASK);
  expect(dialog.getAllByRole('radio')).toHaveLength(1);
  await user.click(dialog.getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', '/tasks/I1/open')).toHaveLength(1));
  const { body } = prCalls(hive, 'POST', '/tasks/I1/open')[0];
  expect(body).toEqual(expect.objectContaining({ kind: 'claude', prompt: 'mergeBase', promptBase: 'main' }));
  expect(body).not.toHaveProperty('continueId');
});

test('a live session that turned busy or ended shows the busy error and the dialog stays open; any other failure shows Erro inesperado (#379)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const user = userEvent.setup();
  hive.answers['POST /tasks/I1/resolve'] = { status: 409, body: { error: 'the session is showing a prompt' } };
  hive.answers['POST /tasks/I1/open'] = { status: 500, body: { error: 'boom' } };
  const { dialog, onClose } = renderDialog();
  await user.click(dialog.getByRole('button', { name: 'enviar' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('a sessão está mostrando um prompt ou já terminou: escolha outra');
  await user.click(dialog.getByRole('radio', { name: 'nova sessão' }));
  await user.click(dialog.getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Erro inesperado'));
  expect(onClose).not.toHaveBeenCalled();
});
