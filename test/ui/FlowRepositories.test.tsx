import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowRepositories } from '@/components/FlowRepositories';
import { resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import { emitReadModelEvent } from '@/lib/review-events';
import { readView, resetViewState } from '@/lib/view-state';
import type { RepoSummary } from '../../src/types';

const repo = (name: string, day: number): RepoSummary => ({
  repository: `acme/${name}`, url: `https://github.com/acme/${name}`, workspace: 'hive', openPrs: day, openIssues: 0, closedIssues: 0, canPush: true, issuesEnabled: true, syncedAt: '2026-10-05T09:00:00Z', lastActivity: `2026-10-0${day}T09:00:00Z`,
});
// newest first by last activity: g f e d c b a
const LIST = [repo('a', 1), repo('b', 2), repo('c', 3), repo('d', 4), repo('e', 5), repo('f', 6), repo('g', 7)];
let listed: RepoSummary[] = LIST;
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(listed), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => {
  setLanguage('pt');
  listed = LIST;
  resetRepositories();
  resetViewState();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// The rows in their order, by their title: the full owner/name
const rowNames = (): string[] => screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((b) => b.title);

test('pinned first in pin order, then the five most recent, the rest behind +N, which expands the list (#757)', async () => {
  const user = userEvent.setup();
  resetViewState({ repositories: { pinned: ['acme/b'] } });
  render(<FlowRepositories onPick={vi.fn()} />);
  expect(await screen.findByText('fixados')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories');
  expect(screen.getByText('recentes')).toBeInTheDocument();
  expect(rowNames()).toEqual(['acme/b', 'acme/g', 'acme/f', 'acme/e', 'acme/d', 'acme/c']);
  expect(within(screen.getByTitle('acme/g')).getByText('7')).toHaveClass('tabular-nums'); // its open PRs
  await user.click(screen.getByRole('button', { name: '+1 repositórios' }));
  expect(rowNames()).toEqual(['acme/b', 'acme/g', 'acme/f', 'acme/e', 'acme/d', 'acme/c', 'acme/a']);
});

test('pin and unpin in the ⋯ move a row and save the pins; abrir no github opens the repository (#757)', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  vi.stubGlobal('open', open);
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('acme/g');
  const menu = async (name: string, item: string): Promise<void> => {
    screen.getByRole('button', { name: `ações de ${name}` }).focus(); // Radix's menu opens on a key under jsdom, not on a click
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('menuitem', { name: item }));
  };
  await menu('acme/c', 'fixar');
  expect(rowNames()[0]).toBe('acme/c');
  expect(readView('repositories')).toEqual({ pinned: ['acme/c'] });
  await menu('acme/c', 'desafixar');
  expect(readView('repositories')).toEqual({ pinned: [] });
  expect(screen.queryByText('fixados')).not.toBeInTheDocument();
  await menu('acme/g', 'abrir no github');
  expect(open).toHaveBeenCalledWith('https://github.com/acme/g', '_blank', 'noreferrer');
});

test('a row\'s click picks its repository and the picked row is pressed; with nothing listed the section is hidden (#757)', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  const { unmount } = render(<FlowRepositories selected="acme/c" onPick={onPick} />);
  await screen.findByTitle('acme/g');
  expect(screen.getByTitle('acme/c')).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(screen.getByTitle('acme/g')).getByText('g'));
  expect(onPick).toHaveBeenCalledWith('acme/g');
  unmount();
  listed = [];
  render(<FlowRepositories onPick={onPick} />);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  // the module's list still holds the last read until the empty answer lands
  await vi.waitFor(() => expect(screen.queryByText('repositórios')).not.toBeInTheDocument());
});

test('a fork workspace\'s original and fork stay together, the original first, named in full, the fork under ↳; the pair sorts by its newest activity and a pin on one pins both (#854)', async () => {
  const user = userEvent.setup();
  listed = [
    repo('a', 1), { ...repo('b', 9), repository: 'ex/excalidraw', role: 'original', pr: 'original', pair: 'me/excalidraw', workspace: 'excalidraw' },
    repo('c', 5), { ...repo('d', 2), repository: 'me/excalidraw', role: 'fork', pr: 'original', pair: 'ex/excalidraw', workspace: 'excalidraw' },
  ];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('ex/excalidraw');
  expect(rowNames()).toEqual(['ex/excalidraw', 'me/excalidraw', 'acme/c', 'acme/a']);
  expect(within(screen.getByTitle('ex/excalidraw')).getByText(/^excalidraw · original/)).toBeInTheDocument();
  expect(within(screen.getByTitle('me/excalidraw')).getByText('↳')).toBeInTheDocument();
  expect(within(screen.getByTitle('me/excalidraw')).getByText(/^fork/)).toHaveClass('pl-[34px]');
  screen.getByRole('button', { name: 'ações de me/excalidraw' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'fixar' }));
  expect(screen.getByText('fixados')).toBeInTheDocument();
  expect(rowNames()).toEqual(['ex/excalidraw', 'me/excalidraw', 'acme/c', 'acme/a']);
});

test('a fork pairs with the repository its pair names, not the one GitHub calls its parent: the upstream remote\'s old name still finds it (#886)', async () => {
  listed = [
    { ...repo('b', 9), repository: 'up/old-name', role: 'original', pr: 'original', pair: 'me/new-name', workspace: 'meet' },
    repo('c', 5),
    { ...repo('d', 2), repository: 'me/new-name', role: 'fork', pr: 'original', pair: 'up/old-name', fork: { parent: 'up/new-name' }, workspace: 'meet' },
  ];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('up/old-name');
  expect(rowNames()).toEqual(['up/old-name', 'me/new-name', 'acme/c']);
  expect(within(screen.getByTitle('me/new-name')).getByText('↳')).toBeInTheDocument();
});

test('an original listed first by another workspace, with no role, still has its fork right after it (#886)', async () => {
  listed = [
    { ...repo('b', 9), repository: 'up/x', workspace: 'other' },
    repo('c', 5),
    { ...repo('d', 2), repository: 'me/x', role: 'fork', pr: 'original', pair: 'up/x', workspace: 'x' },
  ];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('up/x');
  expect(rowNames()).toEqual(['up/x', 'me/x', 'acme/c']);
  expect(within(screen.getByTitle('me/x')).getByText('↳')).toBeInTheDocument();
});

test('a fork whose original is not listed is an ordinary row: no ↳, no fork label, its workspace and short name, sorted by its own activity (#886)', async () => {
  listed = [
    repo('a', 1), repo('c', 5),
    { ...repo('d', 2), repository: 'me/lone', role: 'fork', pr: 'original', pair: 'up/gone', fork: { parent: 'up/gone' }, workspace: 'lone' },
  ];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('me/lone');
  expect(rowNames()).toEqual(['acme/c', 'me/lone', 'acme/a']);
  const row = within(screen.getByTitle('me/lone'));
  expect(row.queryByText('↳')).not.toBeInTheDocument();
  expect(row.queryByText(/^fork/)).not.toBeInTheDocument();
  expect(row.getByText('lone')).toBeInTheDocument(); // the short name, as any row without a role
  expect(row.getByText(/^lone · /)).toHaveClass('pl-4'); // its workspace on the second line, not the fork's indent
});

test('a fork whose original is another pair\'s fork still shows: each row is placed once (#886)', async () => {
  listed = [
    { ...repo('p', 9), repository: 'up/p', role: 'original', pr: 'original', pair: 'me/b', workspace: 'ws2' },
    { ...repo('b', 8), repository: 'me/b', role: 'fork', pr: 'original', pair: 'up/p', workspace: 'ws2' },
    { ...repo('c', 7), repository: 'me/c', role: 'fork', pr: 'original', pair: 'me/b', workspace: 'ws3' },
  ];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('up/p');
  expect(rowNames()).toEqual(['up/p', 'me/b', 'me/c']);
});

test('any readModel event reads the repositories again, whatever its repository or kinds (#182)', async () => {
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('acme/g');
  listed = [...LIST, repo('h', 8)];
  act(() => emitReadModelEvent({ repository: 'acme/elsewhere', kinds: ['labels'] }));
  expect(await screen.findByTitle('acme/h')).toBeInTheDocument();
});

test('a row whose repository the model never synced shows sincronizando… in place of its open PRs (#182)', async () => {
  listed = [{ ...repo('a', 1), syncedAt: null }, repo('b', 2)];
  render(<FlowRepositories onPick={vi.fn()} />);
  await screen.findByTitle('acme/a');
  expect(within(screen.getByTitle('acme/a')).getByRole('status', { name: 'sincronizando…' })).toHaveClass('text-muted-foreground');
  expect(within(screen.getByTitle('acme/a')).queryByText('1')).not.toBeInTheDocument();
  expect(within(screen.getByTitle('acme/b')).queryByRole('status')).not.toBeInTheDocument();
  expect(within(screen.getByTitle('acme/b')).getByText('2')).toHaveClass('tabular-nums');
});

test('a read overtaken by a newer one is dropped, so a burst of events never lands an older list (#182)', async () => {
  let release: (() => void) | undefined;
  fetchMock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return new Response(JSON.stringify([repo('old', 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  render(<FlowRepositories onPick={vi.fn()} />); // the mount's read waits
  listed = [repo('new', 2)];
  await act(async () => emitReadModelEvent({ repository: 'acme/new', kinds: ['issues'] }));
  expect(await screen.findByTitle('acme/new')).toBeInTheDocument();
  await act(async () => release?.());
  expect(screen.queryByTitle('acme/old')).not.toBeInTheDocument();
  expect(screen.getByTitle('acme/new')).toBeInTheDocument();
});
