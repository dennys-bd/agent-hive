import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignCompare, useDesignCompare } from '@/components/DesignCompare';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import * as fileBase from '@/lib/file-base';
import { resetViewState } from '@/lib/view-state';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';

const PATH = 'design/home.hv.html';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const ON_TASK: Activity = { kind: 'task', ...taskPairOf('I1'), task, runs: [], sessions: [], slept: [], status: 'working', worker: true };
const BEFORE_URL = '/design-frame/before/home.hv.html';
let before: unknown = { url: BEFORE_URL };
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/design-frame-base')) return jsonResponse(before);
  if (url.includes('/design-frame')) return jsonResponse({ url: '/design-frame/after/home.hv.html' });
  return jsonResponse({ version: 'v1' }); // the file's version poll; a base ask gets no base and changes nothing here
});
const asked = (): string[] => fetchMock.mock.calls.map(([url]) => url);
const canvases = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-design-canvas]')];
// jsdom keeps no scroll position: each canvas gets a plain one that the test and the hook both write
function scrollable(element: HTMLElement): void {
  for (const name of ['scrollTop', 'scrollLeft']) Object.defineProperty(element, name, { value: 0, writable: true, configurable: true });
}

function Compare() {
  const view = useDesignCompare({ activity: ON_TASK, path: PATH, isDesign: true, isShown: true });
  return <DesignCompare view={view} name="home.hv.html" />;
}

beforeEach(() => {
  setLanguage('pt');
  resetViewState();
  before = { url: BEFORE_URL };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fileBase.closeExcept(new Set());
  vi.unstubAllGlobals();
});

test('the base on the left and the working tree on the right, each captioned; the left minted against the pane\'s base (#675)', async () => {
  render(<Compare />);
  expect(await screen.findByTitle('HEAD · home.hv.html')).toHaveAttribute('src', BEFORE_URL);
  expect(await screen.findByTitle('Árvore de trabalho · home.hv.html')).toHaveAttribute('src', '/design-frame/after/home.hv.html');
  expect(asked()).toContain('/activities/a-I1/design-frame-base?path=design%2Fhome.hv.html&against=head');
});

test('a screen the base does not have leaves the left canvas empty with Não existe na base (#675)', async () => {
  before = { missing: true };
  render(<Compare />);
  expect(await screen.findByText('Não existe na base')).toBeInTheDocument();
  expect(screen.queryByTitle('HEAD · home.hv.html')).toBeNull();
  expect(canvases()).toHaveLength(2); // the layout stays side by side
});

test('scrolling one canvas sets the other to the same pixels, and the echo of that write does not scroll the first back (#675)', () => {
  render(<Compare />);
  const [left, right] = canvases();
  scrollable(left);
  scrollable(right);
  left.scrollTop = 120;
  left.scrollLeft = 30;
  fireEvent.scroll(left);
  expect([right.scrollTop, right.scrollLeft]).toEqual([120, 30]);
  left.scrollTop = 130; // the user goes on before the echo lands
  fireEvent.scroll(right); // the echo of the write above
  expect(left.scrollTop).toBe(130);
  right.scrollTop = 200;
  fireEvent.scroll(right); // a scroll of the right one of its own
  expect(left.scrollTop).toBe(200);
});

test('picking the task base mints the before frame again against it (#675)', async () => {
  render(<Compare />);
  await screen.findByTitle('HEAD · home.hv.html');
  act(() => fileBase.choose('a-I1', PATH, 'task'));
  await waitFor(() => expect(asked()).toContain('/activities/a-I1/design-frame-base?path=design%2Fhome.hv.html&against=task'));
});
