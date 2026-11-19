import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CheckpointsList, checkpointsSummary } from '@/components/CheckpointsList';
import { DiffOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Checkpoint, Stage, Worker } from '../../src/types';
import { jsonResponse } from '../fakes';
import { movedWork, type WithWork } from '../fixtures/work';

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ mode: 'reset', branch: 'hive/1-x' }))); });
afterEach(() => vi.unstubAllGlobals());

const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000).toISOString();
const checkpoint = (n: number, stage: string, ended: Checkpoint['ended']): Checkpoint =>
  ({ n, stage, start: 'a'.repeat(40), head: 'b'.repeat(40), commit: `3f1c9e2${'0'.repeat(33)}`, branch: 'hive/1-x', at: FIVE_MINUTES_AGO, ended });
const stages: Stage[] = ['spec', 'dev'].map((name) => ({ name, from: {}, prompt: '/x' }));
const fixture = (checkpoints: Checkpoint[]): WithWork => ({
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, worktree: '/wt', stopped: true, checkpoints,
});
const stateOf = (checkpoints: Checkpoint[], workers: Worker[] = []) =>
  ({ ...movedWork({ tasks: [fixture(checkpoints)], activities: [], activityRecords: [] }), stages, workers, terminals: [] });
function renderList(state: ReturnType<typeof stateOf>) {
  const openDiff = vi.fn();
  render(<DiffOpenerContext.Provider value={openDiff}><CheckpointsList task={state.tasks[0]} state={state} /></DiffOpenerContext.Provider>);
  return openDiff;
}
const section = (): HTMLElement => screen.getByRole('group', { name: 'pontos de restauração' });

test('the section is hidden while the task has no checkpoint (#619)', () => {
  renderList(stateOf([]));
  expect(screen.queryByRole('group', { name: 'pontos de restauração' })).toBeNull();
});

test('the checkpoints are grouped by stage in column order, each row reading number, age, short sha and how it ended (#619)', () => {
  renderList(stateOf([checkpoint(1, 'dev', 'restart'), checkpoint(2, 'spec', 'done'), checkpoint(3, 'dev', 'restore')]));
  expect(within(section()).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['spec', 'dev']);
  expect(within(section()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'ponto 2 · há 5m · 3f1c9e2 · concluídacompararrestaurar…',
    'ponto 1 · há 5m · 3f1c9e2 · reiniciadacompararrestaurar…',
    'ponto 3 · há 5m · 3f1c9e2 · substituída por uma restauraçãocompararrestaurar…',
  ]);
});

test('comparar opens the diff on the checkpoint scope with that checkpoint; restaurar… opens the dialog (#619)', async () => {
  const user = userEvent.setup();
  const state = stateOf([checkpoint(1, 'dev', 'done')]);
  const openDiff = renderList(state);
  await user.click(within(section()).getByRole('button', { name: 'comparar' }));
  expect(openDiff).toHaveBeenCalledWith(state.tasks[0], 'checkpoint', 1);
  await user.click(within(section()).getByRole('button', { name: 'restaurar…' }));
  expect(await screen.findByRole('dialog', { name: 'Restaurar ponto 1 de dev' })).toBeInTheDocument();
});

test('restaurar… is disabled with its reason while a run is live on the task (#619)', () => {
  const session: Worker = { id: 'w1', status: 'working', runId: 'r1', activityId: 'a-I1', freeSession: true, sessionId: 'abcdef12-0000-4000-8000-000000000000' };
  renderList(stateOf([checkpoint(1, 'dev', 'done')], [session]));
  const button = within(section()).getByRole('button', { name: 'restaurar…' });
  expect(button).toBeDisabled();
  expect(button.parentElement).toHaveAttribute('title', 'pare as execuções da tarefa antes de restaurar');
});

test('pontos de restauração is a details closed by default, with no note; its summary reads the count, the newest one\'s age and its stage (#958)', () => {
  const older = { ...checkpoint(1, 'dev', 'done'), at: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  renderList(stateOf([older, checkpoint(2, 'spec', 'done')]));
  const details = section() as HTMLDetailsElement;
  expect(details.open).toBe(false);
  const summary = details.querySelector('summary')!;
  // the newest is #2, in spec, though dev's column comes later
  expect(summary).toHaveTextContent('2 pontos · último há 5m · spec');
  expect(summary).not.toHaveAttribute('aria-describedby');
});

test('the checkpoints\' summary in the singular and in English (#958)', () => {
  expect(checkpointsSummary([checkpoint(1, 'dev', 'done')], Date.now())).toBe('1 ponto · último há 5m · dev');
  setLanguage('en');
  expect(checkpointsSummary([checkpoint(1, 'dev', 'done'), checkpoint(2, 'spec', 'done')], Date.now())).toBe('2 checkpoints · last 5m ago · spec');
});
