import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RestartDialog } from '@/components/RestartDialog';
import { setLanguage } from '@/i18n';
import type { Session, Stage } from '../../src/types';
import { bareTask, movedWork, type WithWork } from '../fixtures/work';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply({ ok: true }));
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

// The mockup's task (#580): backlog and plan ran before dev, each in its own session
const at = '2026-09-30T10:00:00.000Z';
const session = (id: string, stages: string[]): Session => ({ id, startedAt: at, stages, agent: 'claude' as const, lastUsedAt: at });
const DEV_SESSION = session('a42d1861-0000-4000-8000-000000000003', ['dev']);
const stages: Stage[] = ['backlog', 'plan', 'dev'].map((name) => ({ name, from: { board: [name] }, prompt: '/x' }));
const COMMIT = '3f1c9e2d4b5a69788796a5b4c3d2e1f001234567';
const SESSIONS = [session('b0000000-0000-4000-8000-000000000001', ['backlog']), session('c0000000-0000-4000-8000-000000000002', ['plan']), DEV_SESSION];
const fixture: WithWork = {
  item: { itemId: 'I1', id: '480', title: 'A hung daemon is taken for a stale one', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true,
  stopped: true, stageStart: { stage: 'dev', commit: COMMIT, after: 'plan' },
};
const task = bareTask(fixture);
// #629: the start is the activity's, the sessions its record's
const work = (f: WithWork = fixture, sessions: Session[] = SESSIONS) =>
  movedWork({ stages, tasks: [f], activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions }] });

test('the dialog in reset mode shows the commits, files and session it discards, the start commit at the end of plan and the stages it keeps; confirming posts restart and closes (#283, #580)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  fetchMock.mockImplementationOnce(async () => reply({ mode: 'reset', branch: 'hive/480-x', commits: 4, files: 12 }));
  render(<RestartDialog task={task} state={work()} onClose={onClose} />);
  const dialog = await screen.findByRole('dialog', { name: 'Reiniciar etapa dev' });
  expect(within(dialog).getByText('#480 A hung daemon is taken for a stale one')).toBeInTheDocument();
  expect(within(dialog).getByText('o trabalho desta etapa é descartado e ela executa de novo com uma sessão nova.')).toBeInTheDocument();
  expect(await within(dialog).findByText('4 commits · 12 arquivos · sessão a42d1861')).toBeInTheDocument();
  expect(within(dialog).getByText('3f1c9e2')).toHaveClass('font-mono');
  expect(within(dialog).getByText(/· fim da etapa plan$/)).toBeInTheDocument();
  expect(within(dialog).getByText('resultados de backlog e plan')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/activities/a-I1/restart');
  await user.click(within(dialog).getByRole('button', { name: 'descartar e reiniciar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenLastCalledWith('/activities/a-I1/restart', expect.objectContaining({ method: 'POST' }));
});

test('the branch mode leaves the commits out and says the published branch stays; a refusal stays in the dialog (#283, #580)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  fetchMock.mockImplementationOnce(async () => reply({ mode: 'branch', branch: 'hive/480-x', newBranch: 'hive/480-x-r2', commits: 2, files: 1 }));
  fetchMock.mockImplementationOnce(async () => reply({ error: 'fatal: boom' }, 409));
  render(<RestartDialog task={task} state={work()} onClose={onClose} />);
  expect(await screen.findByText('1 arquivo · sessão a42d1861')).toBeInTheDocument();
  expect(screen.getByText('O branch hive/480-x já foi publicado e fica como está; a etapa recomeça no novo branch hive/480-x-r2.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'descartar e reiniciar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('fatal: boom');
  expect(onClose).not.toHaveBeenCalled();
});

test('without after the start commit reads início da etapa; with no other stage run the mantém row is absent (#580)', async () => {
  const alone = work({ ...fixture, stageStart: { stage: 'dev', commit: COMMIT } }, [DEV_SESSION]);
  fetchMock.mockImplementationOnce(async () => reply({ mode: 'reset', branch: 'hive/480-x', commits: 0, files: 0 }));
  render(<RestartDialog task={task} state={alone} onClose={vi.fn()} />);
  expect(await screen.findByText(/· início da etapa dev$/)).toBeInTheDocument();
  expect(screen.queryByText('mantém')).not.toBeInTheDocument();
});

test('while the preview loads the box is already there: descarta pulses, volta para and mantém read from the task (#580)', async () => {
  fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
  render(<RestartDialog task={task} state={work()} onClose={vi.fn()} />);
  const dialog = await screen.findByRole('dialog', { name: 'Reiniciar etapa dev' });
  const box = within(dialog).getByRole('definition', { busy: true });
  expect(box.querySelector('.animate-pulse')).not.toBeNull();
  expect(within(dialog).getByText(/· fim da etapa plan$/)).toBeInTheDocument();
  expect(within(dialog).getByText('resultados de backlog e plan')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'descartar e reiniciar' })).toBeDisabled();
});
