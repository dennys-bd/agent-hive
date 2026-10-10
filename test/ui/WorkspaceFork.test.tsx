import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceFork } from '@/components/settings/WorkspaceFork';
import { setLanguage } from '@/i18n';
import { emptyWorkspace, type WorkspaceDraft } from '@/lib/settings-form';
import type { ForkSyncAnswer, GitRemote, WorkspaceFork as Fork } from '../../src/types';

// Settings › workspaces › repositório (#854): the suggestion, the switch, the target and how the fork keeps up, and the manual sync.
const BOTH: GitRemote[] = [{ name: 'origin', repository: 'me/app' }, { name: 'upstream', repository: 'acme/app' }];
let remotes: GitRemote[] = BOTH;
let answers: ForkSyncAnswer[] = [];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/settings/remotes?')) return json(remotes);
  return json(url === '/workspaces/app/sync' ? answers.shift() : { ok: true });
});
beforeEach(() => { setLanguage('pt'); remotes = BOTH; answers = []; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

// The section over a row whose fork is `fork`, held as the card holds it; `seen` gets every row a change makes
function Harness({ fork, seen }: { fork: Fork | false | null; seen(row: WorkspaceDraft): void }) {
  const [row, setRow] = useState<WorkspaceDraft>({ ...emptyWorkspace(), name: 'app', path: '/app', fork });
  return <WorkspaceFork row={row} saved onChange={(patch) => { const next = { ...row, ...patch }; setRow(next); seen(next); }} />;
}
const renderFork = (fork: Fork | false | null) => {
  const seen = vi.fn();
  render(<Harness fork={fork} seen={seen} />);
  return seen;
};
const lastFork = (seen: ReturnType<typeof vi.fn>): unknown => (seen.mock.calls.at(-1)?.[0] as WorkspaceDraft | undefined)?.fork;

test('the suggestion shows for a workspace never decided with an upstream remote; aceitar turns the fork on with PRs to the original (#854)', async () => {
  const user = userEvent.setup();
  const seen = renderFork(null);
  expect(await screen.findByRole('status')).toHaveTextContent('o Hive encontrou o remote upstream → acme/app');
  expect(screen.getByText('acme/app')).toHaveClass('font-mono');
  await user.click(screen.getByRole('button', { name: 'aceitar' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'original' });
  expect(screen.getByRole('switch', { name: 'este workspace é uma fork' })).toBeChecked();
  expect(screen.queryByRole('button', { name: 'aceitar' })).not.toBeInTheDocument();
  expect(screen.getByText('abertos em acme/app seguindo o CONTRIBUTING.md dele · a branch sobe para a fork')).toBeInTheDocument();
});

test('não é fork saves false and the suggestion never shows again; with no upstream remote there is none (#854)', async () => {
  const user = userEvent.setup();
  const seen = renderFork(null);
  await user.click(await screen.findByRole('button', { name: 'não é fork' }));
  expect(lastFork(seen)).toBe(false);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByText('tem um remote upstream, mas o Hive trata como repositório próprio')).toBeInTheDocument();
  remotes = [BOTH[0]];
  renderFork(null);
  expect(await screen.findByText('os PRs vão para o próprio repositório')).toBeInTheDocument();
});

test('the switch turns the fork on; PRs to the fork or ask show how it keeps up, starting on GitHub; back to the original drops it (#854)', async () => {
  const user = userEvent.setup();
  const seen = renderFork(false);
  await screen.findByText('tem um remote upstream, mas o Hive trata como repositório próprio');
  await user.click(screen.getByRole('switch', { name: 'este workspace é uma fork' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'original' });
  expect(screen.queryByText('manter a fork em dia com o original')).not.toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: 'a fork' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'fork', sync: 'github' });
  expect(screen.getByRole('radio', { name: 'sincronizar no GitHub' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('radio', { name: 'mesclar na worktree' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'fork', sync: 'local' });
  await user.click(screen.getByRole('radio', { name: 'perguntar' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'ask', sync: 'local' });
  await user.click(screen.getByRole('radio', { name: 'o original' }));
  expect(lastFork(seen)).toEqual({ remote: 'upstream', pr: 'original' });
  expect(screen.queryByText('manter a fork em dia com o original')).not.toBeInTheDocument();
});

test('sincronizar agora posts the manual sync and says what it answered: synced, already up to date, diverged, gh\'s refusal (#854)', async () => {
  const user = userEvent.setup();
  answers = [
    { result: 'synced', mode: 'github', commits: 3, base: 'me:main' }, { result: 'current', mode: 'github', commits: 0, base: 'me:main' },
    { result: 'diverged', mode: 'github', commits: 2, base: 'me:main' }, { result: 'error', mode: 'github', reason: 'gh: HTTP 403', base: 'me:main' },
  ];
  renderFork({ remote: 'upstream', pr: 'fork', sync: 'manual' });
  const sync = screen.getByRole('button', { name: 'sincronizar agora' });
  for (const [first, second] of [
    ['sincronizada', 'a fork recebeu 3 commits do original · agora'],
    ['já estava em dia', 'nenhum commit novo no original · agora'],
    ['não sincronizou: a fork divergiu do original', '2 commits só na fork · resolva na fork e sincronize de novo'],
    ['não sincronizou: gh: HTTP 403', 'confira o login do gh'],
  ]) {
    await user.click(sync);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(first));
    expect(screen.getByRole('status')).toHaveTextContent(second);
    await waitFor(() => expect(sync).toBeEnabled());
  }
  expect(fetchMock.mock.calls.filter(([url]) => url === '/workspaces/app/sync')).toHaveLength(4);
});

test('in an automatic mode the last sync before a worktree shows instead of the button, with its task (#854)', async () => {
  const state = {
    tasks: [{ item: { itemId: 'I1', id: '1042', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true }],
    activities: [{ id: 'a1', kind: 'task' as const, workspace: 'app', sync: { result: 'diverged' as const, mode: 'github' as const, commits: 2, base: 'me:main', sha: 'a1b2c3d', at: new Date().toISOString() } }],
    activityRecords: [{ id: 'a1', taskIds: ['I1'], sessions: [] }],
  };
  render(<WorkspaceFork row={{ ...emptyWorkspace(), name: 'app', path: '/app', fork: { remote: 'upstream', pr: 'fork', sync: 'github' } }} saved state={state as never} onChange={vi.fn()} />);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('não sincronizou antes da worktree de #1042 agora: a fork divergiu do original');
  expect(status).toHaveTextContent('a worktree partiu de origin/main como estava · 2 commits só na fork');
  expect(screen.queryByRole('button', { name: 'sincronizar agora' })).not.toBeInTheDocument();
});
