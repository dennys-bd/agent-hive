import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SleepingRun } from '@/lib/activities';
import { Center, resetCenterTest, seed, SESSION, SHELL, STAGE, strips } from './center-harness';
import { FakeTerminal, FakeWebSocket } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));

// W2, the free session, asleep (#672): its tab stays where it was, beside the stage run's
const S = 'abcdef12-0000-4000-8000-000000000002';
const ASLEEP: SleepingRun[] = [{ run: SESSION, sessionId: S }];
const BOTH = { root: { kind: 'group' as const, id: 'g1', tabs: [{ kind: 'run' as const, ptyId: 'W1' }, { kind: 'run' as const, ptyId: 'W2' }], active: 1 }, focused: 'g1' };
const pane = (ptyId: string): HTMLElement => document.querySelector<HTMLElement>(`[data-pty-id="${ptyId}"]`) as HTMLElement;
const sent = (method: string): string[] => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === method).map(([url]) => String(url));

beforeEach(resetCenterTest);
afterEach(() => vi.unstubAllGlobals());

test('an agent run that ends with its session kept keeps its tab: the dot in the empty colour, the pane dimmed, grey and read-only, the header sleeping (#672)', () => {
  seed(BOTH);
  const { rerender } = render(<Center runs={[STAGE, SESSION]} />);
  act(() => FakeWebSocket.all.find((socket) => socket.path === '/ptys/W2/pty')?.end());
  expect(strips()).toEqual([['Claude', 'Claude · abcdef12']]); // its stream ended: the tab waits for the state
  rerender(<Center runs={[STAGE]} slept={ASLEEP} />);
  expect(strips()).toEqual([['Claude', 'Claude · abcdef12']]);
  const tab = screen.getByRole('tab', { name: 'Claude · abcdef12' });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(tab.querySelector('span')).toHaveClass('bg-empty');
  expect(pane('W2')).toHaveAttribute('data-asleep', 'true');
  expect([pane('W2').style.opacity, pane('W2').style.filter]).toEqual(['0.45', 'grayscale(1)']);
  expect(FakeTerminal.all.at(-1)?.options.disableStdin).toBe(true);
  expect(document.querySelector('[data-pane-header]')).toHaveTextContent('dormindo');
});

test('a click on the sleeping pane continues its session, and the new run takes over the same tab (#672)', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, ptyId: 'W9' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  seed(BOTH);
  const { rerender } = render(<Center runs={[STAGE]} slept={ASLEEP} />);
  await user.click(screen.getByRole('button', { name: 'continuar' }));
  rerender(<Center runs={[STAGE, { ...SESSION, ptyId: 'W9' }]} />); // the broadcast: the session runs in W9, W2 no longer sleeps
  await waitFor(() => expect(FakeWebSocket.all.map((socket) => socket.path)).toContain('/ptys/W9/pty'));
  expect(sent('POST')).toEqual([expect.stringMatching(new RegExp(`/sessions/${S}/open$`))]);
  expect(strips()).toEqual([['Claude', 'Claude · abcdef12']]);
  expect(screen.getByRole('tab', { name: 'Claude · abcdef12' })).toHaveAttribute('aria-selected', 'true');
});

test('a click on the sleeping tab\'s label continues its session too (#672)', async () => {
  const user = userEvent.setup();
  seed({ ...BOTH, root: { ...BOTH.root, active: 0 } });
  render(<Center runs={[STAGE]} slept={ASLEEP} />);
  await user.click(screen.getByRole('tab', { name: 'Claude · abcdef12' }));
  await waitFor(() => expect(sent('POST')).toEqual([expect.stringMatching(new RegExp(`/sessions/${S}/open$`))]));
});

test('closing a sleeping tab forgets its transcript and stops nothing (#672)', async () => {
  const user = userEvent.setup();
  seed(BOTH);
  render(<Center runs={[STAGE]} slept={ASLEEP} />);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(strips()).toEqual([['Claude']]);
  expect(sent('DELETE')).toEqual(['/ptys/W2/scrollback']);
  expect(sent('POST')).toEqual([]);
});

// W3, the task's terminal, asleep (#696): its tab stays as an agent's does, with no session
const TERMINAL_ASLEEP: SleepingRun[] = [{ run: SHELL }];
const WITH_SHELL = { root: { kind: 'group' as const, id: 'g1', tabs: [{ kind: 'run' as const, ptyId: 'W1' }, { kind: 'run' as const, ptyId: 'W3' }], active: 1 }, focused: 'g1' };

test('a sleeping terminal\'s tab is drawn as a sleeping agent\'s; a click wakes it in its own id and its pane connects again; closing it forgets nothing (#696)', async () => {
  const user = userEvent.setup();
  seed(WITH_SHELL);
  const { rerender } = render(<Center runs={[STAGE]} slept={TERMINAL_ASLEEP} />);
  expect(strips()).toEqual([['Claude', 'Terminal']]);
  expect(pane('W3')).toHaveAttribute('data-asleep', 'true');
  expect(document.querySelector('[data-pane-header]')).toHaveTextContent('dormindo');
  await user.click(screen.getByRole('button', { name: 'acordar' }));
  expect(sent('POST')).toEqual(['/terminals/W3/wake']);
  rerender(<Center runs={[STAGE, SHELL]} />); // the broadcast: W3 runs again
  await waitFor(() => expect(FakeWebSocket.all.filter((socket) => socket.path === '/ptys/W3/pty')).toHaveLength(2));
  expect(pane('W3')).not.toHaveAttribute('data-asleep');
  rerender(<Center runs={[STAGE]} slept={TERMINAL_ASLEEP} />);
  await user.click(screen.getByRole('button', { name: 'Fechar Terminal' }));
  expect([strips(), sent('DELETE')]).toEqual([[['Claude']], []]);
});

test('after a restart a tab naming a kept session no run holds stays as a sleeping tab with no transcript, and its click continues it (#696)', async () => {
  const user = userEvent.setup();
  seed({ root: { kind: 'group', id: 'g1', tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'run', ptyId: 'W2', sessionId: S }], active: 1 }, focused: 'g1' });
  render(<Center runs={[STAGE]} keptSessions={[{ id: S, startedAt: '2026-10-03T10:00:00.000Z', stages: [], agent: 'claude', lastUsedAt: '2026-10-03T10:00:00.000Z' }]} />);
  expect(strips()).toEqual([['Claude', 'Claude · abcdef12']]);
  expect(pane('W2')).toHaveAttribute('data-asleep', 'true');
  await user.click(screen.getByRole('button', { name: 'continuar' }));
  await waitFor(() => expect(sent('POST')).toEqual([expect.stringMatching(new RegExp(`/sessions/${S}/open$`))]));
});

test('closing the tab of a session slept before its first prompt forgets its record too (#931)', async () => {
  const user = userEvent.setup();
  seed(BOTH);
  render(<Center runs={[STAGE]} slept={[{ run: { ...SESSION, agent: 'codex' } }]} />);
  await user.click(screen.getByRole('button', { name: 'Fechar Claude · abcdef12' }));
  expect(sent('DELETE')).toEqual(['/ptys/W2/scrollback']);
});
