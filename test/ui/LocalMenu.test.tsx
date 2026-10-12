import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LocalMenuButton } from '@/components/LocalMenu';
import { RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { LocalActivity } from '@/lib/activities';
import { localPairOf } from '../fixtures/work';

const T0 = '2026-09-29T10:00:00.000Z';
const LIVE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const IDLE = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const run = { ptyId: 'L1', label: 'Claude · fix login', kind: 'session' as const, session: 'fix login' };
// hive's local activity: fix login runs now; the other session is kept with nothing running it
const activity: LocalActivity = {
  kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [run], sessions: [{ run, status: 'working' }],
  kept: [
    { session: { id: LIVE, startedAt: T0, stages: [], agent: 'claude', lastUsedAt: T0, name: 'fix login' }, run, status: 'working' },
    { session: { id: IDLE, startedAt: T0, stages: [], agent: 'claude', lastUsedAt: T0 }, status: 'empty' },
  ],
};
const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async () => answer({ ok: true }));
const openRun = vi.fn();
const names = (): string[] => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');

// Radix's DropdownMenu opens from the keyboard under jsdom, as the + test does (#292)
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<RunOpenerContext.Provider value={openRun}><LocalMenuButton activity={activity} /></RunOpenerContext.Provider>);
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: 'nova sessão' });
}

// Radix's submenus and their items are driven from the keyboard under jsdom too: a click on them does not select
async function openSub(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  screen.getByRole('menuitem', { name }).focus();
  await user.keyboard('{ArrowRight}');
}
async function choose(user: ReturnType<typeof userEvent.setup>, item: HTMLElement): Promise<void> {
  item.focus();
  await user.keyboard('{Enter}');
}

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => answer({ ok: true }));
  openRun.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('the local menu lists nova sessão and one entry per kept session, with no stage, diff, flow or delete item; continuar resumes a kept session in the workspace and opens its run there (#590)', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(answer({ ok: true, ptyId: 'L2' }));
  await openMenu(user);
  expect(names()).toEqual(['nova sessão', 'claude · fix login', 'claude · 3f2504e0', 'dormir']);
  await openSub(user, 'claude · 3f2504e0');
  await choose(user, await screen.findByRole('menuitem', { name: 'continuar' }));
  expect(fetchMock).toHaveBeenCalledWith(`/activities/local%3Ahive/sessions/${IDLE}/open`, expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'L2', kind: 'session', project: 'hive', title: 'hive' }));
});

test('a kept session whose run is live can neither continue nor be cleared (#590)', async () => {
  const user = userEvent.setup();
  await openMenu(user);
  await openSub(user, 'claude · fix login');
  expect(await screen.findByRole('menuitem', { name: 'continuar' })).toHaveAttribute('data-disabled');
  expect(screen.getByRole('menuitem', { name: 'limpar' })).toHaveAttribute('data-disabled');
});

test('limpar, in the destructive colour, posts clear for that session only, as its sidebar line does (#587, #590)', async () => {
  const user = userEvent.setup();
  await openMenu(user);
  await openSub(user, 'claude · 3f2504e0');
  const clear = await screen.findByRole('menuitem', { name: 'limpar' });
  expect(clear).toHaveClass('text-destructive');
  await choose(user, clear);
  expect(fetchMock).toHaveBeenCalledWith(`/activities/local%3Ahive/sessions/${IDLE}/clear`, expect.objectContaining({ method: 'POST' }));
});

test('dormir sleeps the local activity\'s one session at once; with a terminal live too it is a submenu whose dormir todas confirms and posts every run (#696)', async () => {
  const user = userEvent.setup();
  const shell = { ptyId: 'T1', label: 'Terminal', kind: 'terminal' as const };
  render(<RunOpenerContext.Provider value={openRun}><LocalMenuButton activity={{ ...activity, runs: [run, shell] }} /></RunOpenerContext.Provider>);
  screen.getByRole('button', { name: 'mais ações' }).focus();
  await user.keyboard('{Enter}');
  await openSub(user, 'dormir');
  await choose(user, await screen.findByRole('menuitem', { name: 'dormir todas' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'dormir todas' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ptys/sleep', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ptyIds: ['L1', 'T1'] }) })));
});

test('nova sessão lists terminal and the agents that can open a free session: no codex until #931 (#927)', async () => {
  const user = userEvent.setup();
  await openMenu(user);
  await openSub(user, 'nova sessão');
  expect(await screen.findByRole('menuitem', { name: 'claude' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'terminal' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'codex' })).not.toBeInTheDocument();
});
