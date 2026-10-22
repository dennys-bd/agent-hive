import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkPrDialog } from '@/components/benchmark/pr/BenchmarkPrDialog';
import { setLanguage } from '@/i18n';
import type { BenchPrPreview } from '../../src/benchmark/pr-pick';
import type { BenchRun } from '../../src/types';
import { experiment, run } from '../benchmark/fixtures';
import { jsonResponse } from '../fakes';

// The dlg-pr screen of docs/agent/design/benchmark.hv.html over one experiment: B's round-1 run has the best mean, A's round-2 run timed out
// with nothing to rebase, B's round-2 run still runs and is never offered
const AT = '2026-10-22T08:00:00.000Z';
const judged = (token: string, armId: string, scores: number[], patch: Partial<BenchRun> = {}): BenchRun => run(token, {
  armId, status: 'done', delivered: 8, total: 8, ...patch,
  evaluation: { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'r'.repeat(64), scores: scores.map((score, i) => ({ dimension: `d${i}`, score, evidence: '' })) } },
});
const EXP = experiment({ status: 'running', rounds: [
  { n: 1, runs: [judged('a1b2c3d4', 'a1', [4, 4]), judged('b1c2d3e4', 'a2', [5, 4])] },
  { n: 2, runs: [judged('a9f8e7d6', 'a1', [3, 3], { round: 2, status: 'timeout', delivered: 5 }), run('b5f6a7b8', { armId: 'a2', round: 2, status: 'running' })] },
] });
const previewOf = (token: string): BenchPrPreview => ({
  token, armId: token.startsWith('a') ? 'a1' : 'a2', status: 'done', commits: token === 'a9f8e7d6' ? 0 : 14, tasks: 8,
  base: 'origin/main', baseSha: 'a42b2fc', branch: 'feat/skills', title: 'feat: Skills', via: 'worktree',
});
const URL_7 = 'https://github.com/owner/repo/pull/7';
const ROUTE = /^\/benchmark\/experiments\/exp-1\/runs\/(\w+)\/pr$/;
let prAnswer = (): Response => jsonResponse({ url: URL_7 });
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const token = ROUTE.exec(url)?.[1];
  if (token === undefined) return jsonResponse({ error: 'unknown' }, 404);
  return init?.method === 'POST' ? prAnswer() : jsonResponse(previewOf(token));
});
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init?.body))]);
const READY = '14 commits das 8 tarefas · rebase sobre a42b2fc';

beforeEach(() => {
  setLanguage('pt');
  prAnswer = () => jsonResponse({ url: URL_7 });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('open', vi.fn());
  fetchMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('opened without a token, the dialog preselects the best-scored run and shows the screen\'s fields from its preview (#477)', async () => {
  render(<BenchmarkPrDialog experiment={EXP} onClose={vi.fn()} />);
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço B' }));
  expect(dialog.getByRole('combobox', { name: 'run' })).toHaveTextContent('par 1 · b1c2d3 · 8/8 · melhor nota');
  expect(dialog.getByText('hive')).toBeInTheDocument();
  expect(await dialog.findByText('origin/main')).toBeInTheDocument();
  expect(dialog.getByRole('textbox', { name: 'branch' })).toHaveValue('feat/skills');
  expect(dialog.getByText(READY)).toBeInTheDocument();
  expect(dialog.getByRole('checkbox', { name: 'incluir o resumo do relatório' })).toBeChecked();
  expect(dialog.getByText('nomes de branch neutros e arquivos do benchmark são tirados antes do push.')).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'abrir PR' })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledWith('/benchmark/experiments/exp-1/runs/b1c2d3e4/pr');
});

test('the picker lists every ended run under its arm with its status; picking another reloads its preview and the title follows its arm (#477)', async () => {
  const user = userEvent.setup();
  render(<BenchmarkPrDialog experiment={EXP} onClose={vi.fn()} />);
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço B' }));
  await user.click(dialog.getByRole('combobox', { name: 'run' }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['par 1 · a1b2c3 · 8/8', 'par 2 · a9f8e7 · 5/8 · timeout', 'par 1 · b1c2d3 · 8/8 · melhor nota']);
  await user.click(screen.getByRole('option', { name: 'par 1 · a1b2c3 · 8/8' }));
  expect(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço A' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/benchmark/experiments/exp-1/runs/a1b2c3d4/pr');
});

test('opened with a token, that run; with 0 commits or a branch name git would refuse, abrir PR stays disabled (#477)', async () => {
  const user = userEvent.setup();
  render(<BenchmarkPrDialog experiment={EXP} token="a9f8e7d6" onClose={vi.fn()} />);
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço A' }));
  expect(await dialog.findByText('0 commits das 8 tarefas · rebase sobre a42b2fc')).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'abrir PR' })).toBeDisabled();
  await user.click(dialog.getByRole('combobox', { name: 'run' }));
  await user.click(screen.getByRole('option', { name: 'par 1 · a1b2c3 · 8/8' }));
  expect(await dialog.findByText(READY)).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'abrir PR' })).toBeEnabled();
  await user.clear(dialog.getByRole('textbox', { name: 'branch' }));
  await user.type(dialog.getByRole('textbox', { name: 'branch' }), '-x');
  expect(dialog.getByRole('button', { name: 'abrir PR' })).toBeDisabled();
  expect(dialog.getByText('não é um nome de branch válido')).toBeInTheDocument();
});

test('a rebase conflict lists its files inline and keeps the dialog open; a branch already on origin is said under the field (#477)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  prAnswer = () => jsonResponse({ error: 'conflict', files: ['src/a.ts', 'src/b.ts'] }, 409);
  render(<BenchmarkPrDialog experiment={EXP} onClose={onClose} />);
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço B' }));
  await dialog.findByText(READY);
  await user.click(dialog.getByRole('button', { name: 'abrir PR' }));
  expect(await dialog.findByText('o rebase conflita nestes arquivos:')).toBeInTheDocument();
  expect(dialog.getByText('src/a.ts')).toBeInTheDocument();
  expect(dialog.getByText('src/b.ts')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
  prAnswer = () => jsonResponse({ error: 'branch-exists' }, 409);
  await user.click(dialog.getByRole('button', { name: 'abrir PR' }));
  expect(await dialog.findByText('já existe um branch com esse nome no origin')).toBeInTheDocument();
  expect(dialog.queryByText('src/a.ts')).not.toBeInTheDocument();
});

test('abrir PR posts the branch and the summary choice, opens the PR\'s URL as every PR link does, and closes (#477)', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<BenchmarkPrDialog experiment={EXP} onClose={onClose} />);
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Abrir PR com o braço B' }));
  await dialog.findByText(READY);
  await user.click(dialog.getByRole('checkbox', { name: 'incluir o resumo do relatório' }));
  await user.click(dialog.getByRole('button', { name: 'abrir PR' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(posts()).toEqual([['/benchmark/experiments/exp-1/runs/b1c2d3e4/pr', { branch: 'feat/skills', withSummary: false }]]);
  expect(window.open).toHaveBeenCalledWith(URL_7, '_blank', 'noreferrer');
});
