import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrMergeBox } from '@/components/PrMergeBox';
import { RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { PrData, State } from '../../src/types';
import { fakePrHive, type FakePrHive, HEAD, PR, prCalls, prData, ROUTE, STATE, WITH_TASK } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());

const box = () => within(screen.getByRole('region', { name: 'mergear' }));
const AWAITING: State = { ...WITH_TASK, activities: [{ ...WITH_TASK.activities[0], approval: { since: '2026-09-30T09:00:00.000Z' } }] };
const CONFLICT = prData({ mergeState: 'conflicts' });
const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const LIVE_WORKER = { id: 's1', status: 'working' as const, runId: 'W1', activityId: 'a-I1', freeSession: true, sessionId: SID };
const FEEDBACK: State = { ...AWAITING, transitions: [{ from: 'dev', to: 'dev', when: 'feedback' }] }; // dev takes feedback
// The box over `pr`, task I1's when `state` holds it; the run opener and onSettled spies; onMerged only when given (#69)
function renderBox(pr: PrData, state: State = WITH_TASK, onMerged?: () => void) {
  const onSettled = vi.fn();
  const openRun = vi.fn();
  const view = render(<RunOpenerContext.Provider value={openRun}><PrMergeBox pr={pr} task={state.tasks[0]} state={state} onSettled={onSettled} onMerged={onMerged} /></RunOpenerContext.Provider>);
  return { ...view, onSettled, openRun };
}

test('ready: ● in working, ready to merge, the facts that hold, the note only on a task awaiting approval, {method} and merge (#758)', () => {
  const { unmount } = renderBox(prData({ approvals: 1, checks: { state: 'success', items: [{ name: 'test', state: 'success' }] } }), AWAITING);
  expect(box().getByText('pronto para merge')).toBeInTheDocument();
  expect(box().getByText('●')).toHaveClass('text-working');
  expect(box().getByText('1 aprovação · checks ok · sem conflitos')).toBeInTheDocument();
  expect(box().getByText('passa a tarefa para a próxima etapa')).toBeInTheDocument();
  expect(box().getByRole('button', { name: 'squash e merge' })).toBeEnabled();
  unmount();
  renderBox(prData());
  expect(box().getByText('sem conflitos')).toBeInTheDocument();
  expect(box().queryByText('passa a tarefa para a próxima etapa')).toBeNull();
});

test('the merge posts the method and the head the page showed, shows GitHub\'s refusal beside it, and reads the PR again, never leaving the page (#592, #758, #69)', async () => {
  const user = userEvent.setup();
  hive.answers[`POST ${ROUTE}/merge`] = { status: 502, body: { error: 'gh api graphql: Pull request is in a merge queue' } };
  const onMerged = vi.fn();
  const { onSettled } = renderBox(prData(), WITH_TASK, onMerged);
  await user.click(box().getByRole('button', { name: 'squash e merge' }));
  expect(prCalls(hive, 'POST', `${ROUTE}/merge`)[0].body).toEqual({ method: 'squash', head: HEAD });
  expect(await box().findByRole('alert')).toHaveTextContent('Pull request is in a merge queue');
  await waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  expect(onMerged).not.toHaveBeenCalled();
});

test('a merge GitHub accepts calls onMerged and skips the re-read; with no onMerged given it reads the PR again (#69)', async () => {
  const user = userEvent.setup();
  const onMerged = vi.fn();
  const first = renderBox(prData(), WITH_TASK, onMerged);
  await user.click(box().getByRole('button', { name: 'squash e merge' }));
  await waitFor(() => expect(onMerged).toHaveBeenCalledOnce());
  expect(first.onSettled).not.toHaveBeenCalled();
  expect(box().queryByRole('alert')).toBeNull();
  first.unmount();
  const second = renderBox(prData());
  await user.click(box().getByRole('button', { name: 'squash e merge' }));
  await waitFor(() => expect(second.onSettled).toHaveBeenCalledOnce());
});

test('conflict: conflicts in N files, the base moved N commits, the merge off with its reason, the files with their directory muted, the note (#758)', () => {
  const { unmount } = renderBox(prData({ mergeState: 'conflicts', behindBy: 3, approvals: 1, conflicts: ['src/a.ts', 'README.md'] }));
  expect(box().getByText('conflitos em 2 arquivos')).toBeInTheDocument();
  expect(box().getByText('●')).toHaveClass('text-destructive');
  expect(box().getByText('1 aprovação · main avançou 3 commits')).toBeInTheDocument();
  const merge = box().getByRole('button', { name: 'squash e merge' });
  expect(merge).toBeDisabled();
  expect(merge.parentElement).toHaveAttribute('title', 'em conflito');
  expect(box().getByText('src/')).toHaveClass('text-muted-foreground');
  expect(box().getByText('src/').parentElement).toHaveTextContent('src/a.ts');
  expect(box().getByText('README.md')).toBeInTheDocument();
  expect(box().getByText('envia o prompt de merge de main: como feedback se a tarefa aguarda aprovação numa etapa que o aceita, senão para a sessão que você escolher.')).toBeInTheDocument();
  unmount();
  renderBox(CONFLICT);
  expect(box().getByText('conflitos')).toBeInTheDocument();
});

test('resolve in the activity on a task awaiting approval whose stage takes feedback posts the merge prompt as started feedback, opens no dialog and focuses nothing, also while a session of the task is live (#379)', async () => {
  const user = userEvent.setup();
  const { openRun } = renderBox(CONFLICT, { ...FEEDBACK, workers: [LIVE_WORKER] });
  await user.click(box().getByRole('button', { name: 'resolver na atividade' }));
  await waitFor(() => expect(prCalls(hive, 'POST', '/activities/a-I1/feedback')[0]?.body).toEqual({ prompt: 'mergeBase', promptBase: 'main', start: true }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(openRun).not.toHaveBeenCalled();
  expect(hive.calls.some((c) => c.url.endsWith('/open') || c.url.endsWith('/resolve'))).toBe(false);
});

test('resolve in the activity on any other task opens the resolve dialog, also with no session and on a task awaiting approval with no feedback transition (#379)', async () => {
  const user = userEvent.setup();
  const first = renderBox(CONFLICT);
  await user.click(box().getByRole('button', { name: 'resolver na atividade' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Resolver o conflito com main' });
  expect(within(dialog).getByRole('radio', { name: 'nova sessão' })).toBeChecked();
  expect(hive.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  first.unmount();
  renderBox(CONFLICT, AWAITING);
  await user.click(box().getByRole('button', { name: 'resolver na atividade' }));
  expect(await screen.findByRole('alertdialog', { name: 'Resolver o conflito com main' })).toBeInTheDocument();
  expect(prCalls(hive, 'POST', '/activities/a-I1/feedback')).toHaveLength(0);
});

test('resolve in the activity sends its feedback once while the request runs: a second click waits (#758, #379)', async () => {
  const user = userEvent.setup();
  const fake = fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/feedback')) await gate;
    return fake(input, init);
  }));
  renderBox(CONFLICT, FEEDBACK);
  const button = box().getByRole('button', { name: 'resolver na atividade' });
  await user.dblClick(button);
  expect(button).toBeDisabled();
  release();
  await waitFor(() => expect(button).toBeEnabled());
  expect(prCalls(hive, 'POST', '/activities/a-I1/feedback')).toHaveLength(1);
});

test('a PR without a task has no resolve and no note; a later slice of the stack waits for the earlier one; a merged PR has no box (#698, #758)', () => {
  const { unmount } = renderBox(CONFLICT, STATE);
  expect(box().queryByRole('button', { name: 'resolver na atividade' })).toBeNull();
  expect(box().queryByText(/envia o prompt de merge/)).toBeNull();
  unmount();
  const stacked: State = { ...WITH_TASK, activityRecords: [{ ...WITH_TASK.activityRecords[0], prs: [
    { url: 'https://github.com/acme/app/pull/6', state: 'open', slice: { k: 1, type: 'stacked' } }, { url: PR, state: 'open', slice: { k: 2, type: 'stacked' } },
  ] }] };
  const second = renderBox(prData(), stacked);
  expect(box().getByText('mergeie #6 antes')).toBeInTheDocument();
  expect(box().getByText('●')).toHaveClass('text-waiting');
  expect(box().getByRole('button', { name: 'squash e merge' }).parentElement).toHaveAttribute('title', 'mergeie #6 antes');
  second.unmount();
  renderBox(prData({ state: 'merged' }));
  expect(screen.queryByRole('region', { name: 'mergear' })).toBeNull();
});

test('without push rights: sem permissão de merge in muted with the facts, abrir no github, the merge off with its reason, and the note; a conflict still comes first (#854)', () => {
  const { unmount } = renderBox(prData({ canPush: false, approvals: 1, checks: { state: 'success', items: [{ name: 'test', state: 'success' }] } }));
  expect(box().getByText('sem permissão de merge')).toBeInTheDocument();
  expect(box().getByText('●')).toHaveClass('text-muted-foreground');
  expect(box().getByText('1 aprovação · checks ok · sem conflitos')).toBeInTheDocument();
  expect(box().getByRole('button', { name: 'abrir no github' })).toBeEnabled();
  const merge = box().getByRole('button', { name: 'squash e merge' });
  expect(merge).toBeDisabled();
  expect(merge.parentElement).toHaveAttribute('title', 'sem permissão de escrita em acme/app');
  expect(box().getByText('você não tem permissão de escrita em acme/app. o merge fica com um mantenedor; quando acontecer, a tarefa segue para a próxima etapa.')).toBeInTheDocument();
  unmount();
  renderBox(prData({ canPush: false, checks: { state: 'pending', items: [], awaiting: ['CI'] } }));
  expect(box().getByText('checks aguardam aprovação · sem conflitos')).toBeInTheDocument();
});

test('a PR no task holds that awaits review: ● aguarda review in muted, the facts that hold, the merge off in outline with the same words as its tooltip, no note; it comes before the no-permission box (#68)', () => {
  const asked = prData({
    decision: 'pending', approvals: 1, reviewRequests: [{ reviewer: 'ana', team: false, viewer: true }],
    checks: { state: 'success', items: [{ name: 'test', state: 'success' }] },
  });
  const { unmount } = renderBox(asked, STATE);
  expect(box().getByText('aguarda review')).toBeInTheDocument();
  expect(box().getByText('●')).toHaveClass('text-muted-foreground');
  expect(box().getByText('review pedido a você · checks ok · sem conflitos')).toBeInTheDocument();
  const merge = box().getByRole('button', { name: 'squash e merge' });
  expect(merge).toBeDisabled();
  expect(merge).toHaveAttribute('data-variant', 'outline');
  expect(merge.parentElement).toHaveAttribute('title', 'aguarda review');
  expect(box().queryByText('passa a tarefa para a próxima etapa')).toBeNull();
  unmount();
  renderBox(prData({ decision: 'pending', canPush: false }), STATE);
  expect(box().getByText('aguarda review')).toBeInTheDocument();
  expect(box().getByText('sem conflitos')).toBeInTheDocument(); // no request of the viewer's, no passing checks
  expect(box().queryByText('sem permissão de merge')).toBeNull();
});

test('without a task an approved mergeable PR keeps the ready box with no note, conflicts keep the conflict box, and a task\'s PR awaiting review keeps the ready box (#68)', () => {
  const ready = renderBox(prData({ decision: 'approved', approvals: 1 }), STATE);
  expect(box().getByText('pronto para merge')).toBeInTheDocument();
  expect(box().getByRole('button', { name: 'squash e merge' })).toBeEnabled();
  expect(box().queryByText('passa a tarefa para a próxima etapa')).toBeNull();
  ready.unmount();
  const conflict = renderBox(prData({ decision: 'pending', mergeState: 'conflicts' }), STATE);
  expect(box().getByText('conflitos')).toBeInTheDocument();
  conflict.unmount();
  renderBox(prData({ decision: 'pending' }), WITH_TASK);
  expect(box().getByText('pronto para merge')).toBeInTheDocument();
});
