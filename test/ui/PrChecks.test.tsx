import { act as run, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrChecks } from '@/components/PrChecks';
import { CHECKS_POLL_MS, usePr } from '@/hooks/use-pr';
import { setLanguage } from '@/i18n';
import { AT, fakePrHive, type FakePrHive, PR, prCalls, prData, ROUTE } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); hive = fakePrHive(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const gets = (url: string): number => hive.calls.filter((c) => c.method === 'GET' && c.url === url).length;
const box = () => within(screen.getByRole('region', { name: 'checks' }));
const PENDING = { state: 'pending' as const, items: [{ name: 'test', state: 'pending' as const }] };

test('the header counts the passed of all, with ✓ while all passed; each check links to GitHub when it has a page (#758)', () => {
  render(<PrChecks checks={{ state: 'success', at: AT, items: [{ name: 'test', state: 'success', url: 'https://github.com/acme/app/runs/1' }, { name: 'lint', state: 'success' }] }} />);
  expect(box().getByText('checks · 2 de 2 passaram')).toBeInTheDocument();
  expect(box().getAllByText('✓')[0]).toHaveClass('text-working');
  expect(box().getByRole('link', { name: 'test' })).toHaveAttribute('href', 'https://github.com/acme/app/runs/1');
  expect(box().queryByRole('link', { name: 'lint' })).toBeNull();
});

test('a failed check turns the mark to ✕ and says how many failed; a running one says how many are pending; none hides the box (#758)', () => {
  const { rerender } = render(<PrChecks checks={{ state: 'failure', items: [{ name: 'test', state: 'failure' }, { name: 'lint', state: 'pending' }, { name: 'e2e', state: 'success' }] }} />);
  expect(box().getByText('checks · 1 de 3 passaram')).toBeInTheDocument();
  expect(box().getByText('· 1 falharam')).toHaveClass('text-destructive');
  expect(box().getByText('· 1 pendentes')).toHaveClass('text-waiting');
  expect(box().getAllByText('✕')[0]).toHaveClass('text-destructive');
  rerender(<PrChecks checks={PENDING} />);
  expect(box().getAllByText('●')[0]).toHaveClass('text-waiting');
  rerender(<PrChecks />);
  expect(screen.queryByRole('region', { name: 'checks' })).toBeNull();
});

test('a pending check reads …/checks every 30 s while shown and its checks land in the PR; with nothing pending, nothing is read (#758)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hive.pr = prData({ checks: PENDING });
  hive.answers[`GET ${ROUTE}/checks`] = { status: 200, body: { mergeState: 'clean', updatedAt: AT, checks: { state: 'success', items: [{ name: 'test', state: 'success' }] } } };
  const { result } = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(result.current.load.status).toBe('ready'));
  expect(gets(`${ROUTE}/checks`)).toBe(0);
  await run(async () => { await vi.advanceTimersByTimeAsync(CHECKS_POLL_MS); });
  await waitFor(() => expect(result.current.load.status === 'ready' ? result.current.load.pr.checks?.state : undefined).toBe('success'));
  expect(gets(ROUTE), 'the same updatedAt: no whole read').toBe(1);
  await run(async () => { await vi.advanceTimersByTimeAsync(CHECKS_POLL_MS * 2); });
  expect(gets(`${ROUTE}/checks`), 'nothing pending any more').toBe(1);
});

test('a poll whose updatedAt is newer reads the PR whole; a hidden page neither reads nor polls (#758)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hive.pr = prData({ checks: PENDING });
  hive.answers[`GET ${ROUTE}/checks`] = { status: 200, body: { mergeState: 'clean', updatedAt: '2026-10-07T09:00:00.000Z', checks: PENDING } };
  const shown = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(gets(ROUTE)).toBe(1));
  await run(async () => { await vi.advanceTimersByTimeAsync(CHECKS_POLL_MS); });
  await waitFor(() => expect(gets(ROUTE)).toBe(2));
  shown.unmount();
  hive.calls.splice(0);
  renderHook(() => usePr(PR, false));
  await run(async () => { await vi.advanceTimersByTimeAsync(CHECKS_POLL_MS * 2); });
  expect(gets(ROUTE) + gets(`${ROUTE}/checks`)).toBe(0);
});

const FAILED = { state: 'failure' as const, items: [{ name: 'test', state: 'failure' as const }, { name: 'lint', state: 'success' as const }] };

test('re-executar falhas shows only on a failure and posts the re-run; without push rights it is off with its reason and the band says who can (#854)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<PrChecks checks={FAILED} pr={{ url: PR, canPush: true }} />);
  await user.click(box().getByRole('button', { name: 're-executar falhas' }));
  expect(prCalls(hive, 'POST', `${ROUTE}/checks/rerun`)).toHaveLength(1);
  rerender(<PrChecks checks={FAILED} pr={{ url: PR, canPush: false }} />);
  const rerun = box().getByRole('button', { name: 're-executar falhas' });
  expect(rerun).toBeDisabled();
  expect(rerun.parentElement).toHaveAttribute('title', 'sem permissão em acme/app');
  expect(box().getByText('sem permissão para re-executar em acme/app. um push novo no PR executa o CI de novo, ou um mantenedor re-executa.')).toBeInTheDocument();
  rerender(<PrChecks checks={{ state: 'success', items: [{ name: 'lint', state: 'success' }] }} pr={{ url: PR, canPush: true }} />);
  expect(box().queryByRole('button', { name: 're-executar falhas' })).toBeNull();
});

test('workflows awaiting approval: ◷ checks · aguardam aprovação, abrir no github, the text with their count and the list (#854)', () => {
  render(<PrChecks checks={{ state: 'pending', items: [], awaiting: ['CI', 'Lint'] }} pr={{ url: PR, canPush: false }} />);
  expect(box().getByText('checks · aguardam aprovação')).toBeInTheDocument();
  expect(box().getByRole('link', { name: 'abrir no github' })).toHaveAttribute('href', PR);
  expect(box().getByText('2 workflows não executaram: aguardam a aprovação de um mantenedor de acme/app. o GitHub pede isso em PRs de forks, em geral na primeira contribuição.')).toBeInTheDocument();
  expect(box().getByText('Lint')).toBeInTheDocument();
});
