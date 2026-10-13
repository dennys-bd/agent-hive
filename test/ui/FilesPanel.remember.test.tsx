import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { setLanguage } from '@/i18n';
import { readView, resetViewState, VIEW_WRITE_DELAY_MS } from '@/lib/view-state';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

// What the files tree remembers (#947): show hidden files as the user's preference in the view state, the open folders per activity for the page
const taskOf = (itemId: string): Task => ({ item: { itemId, id: itemId, title: `Task ${itemId}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true });
const activityOf = (itemId: string): TaskActivity =>
  ({ kind: 'task', ...taskPairOf(itemId, { slug: `hive-${itemId}`, branch: `hive/${itemId}` }), task: taskOf(itemId), runs: [], sessions: [], status: 'empty', worker: false });
const TREE: TaskTree = { root: '/wt', files: ['src/a.ts', 'README.md', '.env'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(TREE) : new Response(null, { status: 204 })));
const side = (itemId = 'I1') => <ActivitySide key={itemId} target={activityOf(itemId)} tab="files" isShown />;
const toggleHidden = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'mostrar arquivos ocultos' }));
};

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('with no stored preference the tree leaves hidden files out (#947)', async () => {
  render(side());
  await screen.findByRole('button', { name: 'README.md' });
  expect(screen.queryByRole('button', { name: '.env' })).not.toBeInTheDocument();
});

test('a stored true shows hidden files on mount, in any activity (#947)', async () => {
  resetViewState({ filesShowHidden: true });
  const { rerender } = render(side('I1'));
  expect(await screen.findByRole('button', { name: '.env' })).toBeInTheDocument();
  rerender(side('I2'));
  expect(await screen.findByRole('button', { name: '.env' })).toBeInTheDocument();
});

test('a stored value that is not true reads as off (#947)', async () => {
  resetViewState({ filesShowHidden: 'yes' });
  render(side());
  await screen.findByRole('button', { name: 'README.md' });
  expect(screen.queryByRole('button', { name: '.env' })).not.toBeInTheDocument();
});

test('turning show hidden files on and off writes the preference and posts it (#947)', async () => {
  const user = userEvent.setup();
  render(side());
  await screen.findByRole('button', { name: 'README.md' });
  await toggleHidden(user);
  expect(readView('filesShowHidden')).toBe(true);
  await toggleHidden(user);
  expect(readView('filesShowHidden')).toBe(false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, VIEW_WRITE_DELAY_MS + 50)); });
  const posts = fetchMock.mock.calls.filter(([url, init]) => url === '/view-state/filesShowHidden' && init?.method === 'POST');
  expect(posts.at(-1)?.[1]?.body).toBe('{"value":false}');
});

test('a folder opened stays open when the activity is left and shown again; another activity starts collapsed (#947)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(side('I1'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  expect(await screen.findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
  rerender(side('I2'));
  await screen.findByRole('button', { name: 'src' });
  expect(screen.queryByRole('button', { name: 'a.ts' })).not.toBeInTheDocument();
  rerender(side('I1'));
  expect(await screen.findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
});

test('recolher tudo is remembered too: the activity shown again starts collapsed (#947)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(side('I1'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(screen.getByRole('menuitem', { name: 'recolher tudo' }));
  rerender(side('I2'));
  await screen.findByRole('button', { name: 'src' });
  rerender(side('I1'));
  await screen.findByRole('button', { name: 'src' });
  expect(screen.queryByRole('button', { name: 'a.ts' })).not.toBeInTheDocument();
});
