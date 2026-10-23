import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RunFooter, RunHeader, runMeta } from '@/components/benchmark/run-mode/RunChrome';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, State, Worker } from '../../src/types';
import { stateWith } from '../benchmark/fixtures';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { frozen, RUN } from './run-hive-fixtures';

const NOW = Date.parse('2026-10-22T15:12:00.000Z');
const TASK: WithWork = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const worker = (status: Worker['status']): Worker => ({ id: 's1', status, activityId: activityIdOf('A'), runId: 'W1' });
const live = (status: Worker['status']): State => withPointedWork({ ...stateWith(), tasks: [TASK], workers: [worker(status)] });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.restoreAllMocks());

test('the header: the breadcrumb experiment › arm badge and name › par N, and the chip executando, aguardando aprovação or congelada (#469)', () => {
  const { rerender } = render(<RunHeader run={RUN} state={live('working')} />);
  const crumbs = screen.getByRole('navigation', { name: 'caminho' });
  expect(crumbs).toHaveTextContent('skills: comandos × plugin›Bskills do plugin›par 2');
  expect(screen.getByTestId('run-chip')).toHaveTextContent('executando');
  expect(screen.getByTestId('run-chip')).toHaveClass('text-working');
  rerender(<RunHeader run={RUN} state={live('waiting')} />);
  expect(screen.getByTestId('run-chip')).toHaveTextContent('aguardando aprovação');
  expect(screen.getByTestId('run-chip')).toHaveClass('text-waiting');
  rerender(<RunHeader run={frozen(RUN)} state={live('waiting')} />);
  expect(screen.getByTestId('run-chip')).toHaveTextContent('congelada');
});

test('time · tokens: since the first session began and every task\'s tokens as Detalhes counts them; 0m · 0 tokens before any (#469)', () => {
  expect(runMeta(stateWith(), NOW)).toBe('0m · 0 tokens');
  const record: ActivityRecord = {
    id: 'r1', taskIds: ['A'], usage: { tokens: 1_400_000, ms: 0, waitingMs: 0, parts: [] },
    sessions: [{ id: 's-1', startedAt: '2026-10-22T12:00:00.000Z', lastUsedAt: '2026-10-22T12:00:00.000Z', stages: ['dev'], agent: 'claude' }],
  };
  expect(runMeta({ ...stateWith(), tasks: [TASK], activityRecords: [record] }, NOW)).toBe('3h12m · 1.4M tokens');
});

test('voltar ao benchmark goes back to the main window\'s page; the footer names the home, origin, environment and the arm\'s pair (#469)', async () => {
  const user = userEvent.setup();
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
  render(<><RunHeader run={RUN} state={stateWith()} /><RunFooter run={RUN} /></>);
  await user.click(screen.getByRole('button', { name: 'voltar ao benchmark' }));
  expect(back).toHaveBeenCalledTimes(1);
  for (const text of ['home isolada · bench/runs/k9f2a6d1', 'origin local', 'ambiente · local', 'braço B · par 2 de 3']) expect(screen.getByText(text)).toBeInTheDocument();
});
