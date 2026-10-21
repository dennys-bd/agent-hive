import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { PARTS_MAX, partsOf } from '@/hooks/use-design-parts';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';

const PATH = 'design/Landing.hv.html';
const NAME = 'Landing.hv.html';
const LABEL = '#1 Task 1 · Design Landing.hv.html';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const activity: Activity = { kind: 'task', ...taskPairOf('I1', { worktree: '/w/hive-1' }), task, runs: [], sessions: [], status: 'working', worker: true };

// Each file's version on the disk by its path from the activity; null or absent: the file is not there
let versions: Record<string, string | null> = {};
const pathOf = (url: string): string => new URLSearchParams(url.split('?')[1]).get('path') ?? '';
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/tasks/I1/review') return jsonResponse({ reviewed: [], drafts: [], threads: [] });
  if (!url.includes('/file-version')) return jsonResponse({ url: '/design-frame/tok/Landing.hv.html' });
  const version = versions[pathOf(url)];
  return version === null || version === undefined ? jsonResponse({ error: 'file not found' }, 404) : jsonResponse({ version });
});
const asked = (): string[] => fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes('/file-version')).map(pathOf);
const frame = (): HTMLIFrameElement => screen.getByTitle(NAME);
const fromFrame = (data: unknown): void => {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: frame().contentWindow })); });
};
// The reads in flight settle; a poll is a window focus, which asks at once (use-file-version.ts)
const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); }); };
async function poll(): Promise<void> {
  await act(async () => {
    fireEvent.focus(window);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

beforeEach(() => {
  showCommentsPanel(false);
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  versions = { [PATH]: 'v1', 'design/parts/nav.html': 'n1' };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

test('the pane polls each part its frame reports, from the screen\'s folder, and reloads on a change, a missing part appearing included (#421)', async () => {
  render(<DesignPane activity={activity} path={PATH} label={LABEL} active />);
  const first = await screen.findByTitle(NAME);
  fromFrame({ hive: 'design', type: 'parts', parts: ['parts/nav.html', 'parts/gone.html'] });
  await settle(); // the immediate read: the baselines, the missing part's null among them
  await poll();
  expect(frame()).toBe(first);
  expect(asked()).toEqual(expect.arrayContaining(['design/parts/nav.html', 'design/parts/gone.html']));
  versions['design/parts/nav.html'] = 'n2';
  await poll();
  const second = frame();
  expect(second).not.toBe(first);
  fromFrame({ hive: 'design', type: 'parts', parts: ['parts/nav.html', 'parts/gone.html'] }); // the new load reports the same list
  versions['design/parts/gone.html'] = 'g1';
  await poll();
  expect(frame()).not.toBe(second);
});

test('a reported list keeps only relative paths with no .., dot or empty segment, each once, at most 32 (#421)', () => {
  expect(partsOf(['parts/a.html', 'parts/a.html', '/abs.html', '../up.html', 'parts/../x.html', '.git/x.html', 'parts/.x.html', 'a\\b.html', 'p//x.html', '', 7, null])).toEqual(['parts/a.html']);
  expect(partsOf('parts/a.html')).toEqual([]);
  expect(partsOf(Array.from({ length: 40 }, (_, i) => `p${i}.html`))).toHaveLength(PARTS_MAX);
});
