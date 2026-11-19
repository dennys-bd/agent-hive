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

// #909: each half reads its own frame's hv-tweaks block and keeps its own values
const BEFORE_FRAME = 'HEAD · home.hv.html';
const AFTER_FRAME = 'Árvore de trabalho · home.hv.html';
const frameOf = (title: string): HTMLIFrameElement => screen.getByTitle(title) as HTMLIFrameElement;
function fromFrame(title: string, data: Record<string, unknown>): void {
  const source = frameOf(title).contentWindow;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { hive: 'design', ...data }, source })); });
}
function tweakPosts(title: string): () => unknown[] {
  const target = frameOf(title).contentWindow;
  if (target === null) throw new Error('the frame has no window');
  const spy = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([data]) => data).filter((data) => (data as { type?: string }).type === 'tweak');
}
const rows = (): HTMLElement[] => screen.queryAllByRole('toolbar', { name: 'tweaks' });

test('no tweaks row on a half whose frame declares no block, only a spacer while the other half has one (#909)', async () => {
  render(<Compare />);
  await screen.findByTitle(BEFORE_FRAME);
  await screen.findByTitle(AFTER_FRAME);
  expect(rows()).toHaveLength(0);
  fromFrame(AFTER_FRAME, { type: 'tweaks', schema: { sync: { type: 'boolean', default: false } } });
  expect(rows()).toHaveLength(1);
  expect(screen.getByRole('switch', { name: 'sync' })).toBeInTheDocument();
  expect(document.querySelectorAll('[data-tweak-spacer]')).toHaveLength(1); // the before half holds the row's place, so both canvases line up
});

test('each half shows its own block, and a pick on one half reaches only that half\'s frame (#909)', async () => {
  render(<Compare />);
  await screen.findByTitle(BEFORE_FRAME);
  await screen.findByTitle(AFTER_FRAME);
  const [left, right] = [tweakPosts(BEFORE_FRAME), tweakPosts(AFTER_FRAME)];
  fromFrame(BEFORE_FRAME, { type: 'tweaks', schema: { sync: { type: 'boolean', default: false } } });
  fromFrame(AFTER_FRAME, { type: 'tweaks', schema: { sync: { type: 'boolean', default: false }, dense: { type: 'boolean', default: true } } });
  expect(rows()).toHaveLength(2);
  expect(screen.getAllByRole('switch', { name: 'sync' })).toHaveLength(2);
  expect(screen.getAllByRole('switch', { name: 'dense' })).toHaveLength(1); // only the after declares it
  fireEvent.click(screen.getAllByRole('switch', { name: 'sync' })[1]);
  expect(right().at(-1)).toEqual({ hive: 'design', type: 'tweak', name: 'sync', value: true });
  expect(left()).toEqual([{ hive: 'design', type: 'tweak', name: 'sync', value: false }]); // only its own defaults, sent on its block
  expect(screen.getAllByRole('switch', { name: 'sync' })[0]).not.toBeChecked();
});
