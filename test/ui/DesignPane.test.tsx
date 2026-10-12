import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { ReviewFile, Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { localPairOf, taskPairOf } from '../fixtures/work';
import { PATH as REVIEW_PATH, REVIEW } from './design-review';

const PATH = 'design/Landing.hv.html';
const NAME = 'Landing.hv.html';
const FRAME_URL = '/design-frame/tok/Landing.hv.html';
const LABEL = '#1 Task 1 · Design Landing.hv.html';
const CANVAS_PX = 672; // (672 − 32) / 1280: a 50% fit at desktop
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const activity: Activity = { kind: 'task', ...taskPairOf('I1', { worktree: '/w/hive-1' }), task, runs: [], sessions: [], status: 'working', worker: true };
// What the routes answer: the review (#113), a write's ok, the mint, and the file's version (null: the file is gone)
let mint: () => Response = () => jsonResponse({ url: FRAME_URL });
let version: string | null = 'v1';
let review: ReviewFile = { reviewed: [], drafts: [], threads: [] };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/tasks/I1/review') return jsonResponse(review);
  if ((init?.method ?? 'GET') !== 'GET') return jsonResponse({ failed: [] });
  if (!url.includes('/file-version')) return mint();
  return version === null ? jsonResponse({ error: 'file not found' }, 404) : jsonResponse({ version });
});

const pane = () => <DesignPane activity={activity} path={PATH} label={LABEL} active />;
const frame = (): HTMLIFrameElement => screen.getByTitle(NAME);
const percent = (): string => screen.getByTitle('⌘0 ajusta à tela').textContent ?? '';
const fromFrame = (data: unknown, source: Window | null = frame().contentWindow): void => {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
};
function frameWindow(): Window {
  const win = frame().contentWindow;
  if (win === null) throw new Error('the frame has no window');
  return win;
}

beforeEach(() => {
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  mint = () => jsonResponse({ url: FRAME_URL });
  version = 'v1';
  review = { reviewed: [], drafts: [], threads: [] };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  // jsdom lays nothing out: the canvas alone gets a width, so the fit has something to measure
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return this.hasAttribute('data-design-canvas') ? CANVAS_PX : 0; });
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('mints the frame with the activity and the path, renders it sandboxed at 1280 px and 800 high, scaled to fit; a size from its frame sets the height, any other is ignored (#109)', async () => {
  render(pane());
  const iframe = await screen.findByTitle(NAME);
  expect(fetchMock.mock.calls[0][0]).toBe('/activities/a-I1/design-frame?path=design%2FLanding.hv.html');
  expect(iframe).toHaveAttribute('src', FRAME_URL);
  expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  expect([iframe.getAttribute('width'), iframe.getAttribute('height')]).toEqual(['1280', '800']);
  expect(percent()).toBe('50%');
  expect(iframe.style.transform).toBe('scale(0.5)');
  expect(screen.getByRole('region', { name: LABEL })).toBeInTheDocument();
  expect(screen.getByTitle(PATH)).toHaveTextContent(PATH);
  fromFrame({ hive: 'design', type: 'size', height: 1500 });
  fromFrame({ hive: 'design', type: 'size', height: 900 }, window); // not this pane's frame
  fromFrame({ hive: 'design', type: 'size', height: '900' });
  fromFrame({ type: 'size', height: 900 });
  expect(frame()).toHaveAttribute('height', '1500');
  expect(document.querySelector<HTMLElement>('[data-design-box]')?.style.height).toBe('750px');
});

test('a refused mint shows the route\'s words in place of the canvas, with no frame (#109)', async () => {
  mint = () => jsonResponse({ error: 'not a Hive design' }, 400);
  render(pane());
  expect(await screen.findByRole('alert')).toHaveTextContent('not a Hive design');
  expect(screen.queryByTitle(NAME)).toBeNull();
  expect(document.querySelector('[data-design-canvas]')).toBeNull();
});

test('tablet and mobile set the frame to 768 and 390 px and refit; the theme goes to the frame on each ready and each toggle, and the Hive\'s stays (#109)', async () => {
  const user = userEvent.setup();
  render(pane());
  await screen.findByTitle(NAME);
  await user.click(screen.getByRole('radio', { name: 'tablet' }));
  expect([frame().getAttribute('width'), percent()]).toEqual(['768', '83%']);
  await user.click(screen.getByRole('radio', { name: 'mobile' }));
  expect([frame().getAttribute('width'), percent()]).toEqual(['390', '100%']);
  const posted = vi.spyOn(frameWindow(), 'postMessage').mockImplementation(() => undefined);
  fromFrame({ hive: 'design', type: 'ready' });
  expect(posted).toHaveBeenLastCalledWith({ hive: 'design', type: 'theme', theme: 'dark' }, '*');
  await user.click(screen.getByRole('radio', { name: 'claro' }));
  expect(posted).toHaveBeenLastCalledWith({ hive: 'design', type: 'theme', theme: 'light' }, '*');
  expect(screen.getByRole('radio', { name: 'claro' })).toHaveAttribute('aria-checked', 'true');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

test('+ and − step the zoom by 10 points within 10–200%, and ⌘0 in the pane fits again (#109)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const zoomIn = screen.getByRole('button', { name: 'aumentar zoom' });
  const zoomOut = screen.getByRole('button', { name: 'diminuir zoom' });
  fireEvent.click(zoomIn);
  expect(percent()).toBe('60%');
  for (let i = 0; i < 10; i += 1) fireEvent.click(zoomOut);
  expect(percent()).toBe('10%');
  for (let i = 0; i < 25; i += 1) fireEvent.click(zoomIn);
  expect(percent()).toBe('200%');
  fireEvent.keyDown(screen.getByRole('region', { name: LABEL }), { key: '0', metaKey: true });
  expect(percent()).toBe('50%');
});

test('Space held in the pane turns the canvas to grab and lets a drag pass over the frame; released, both come back (#109)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const region = screen.getByRole('region', { name: LABEL });
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas]');
  fireEvent.keyDown(region, { key: ' ' });
  expect([canvas?.style.cursor, frame().style.pointerEvents]).toEqual(['grab', 'none']);
  fireEvent.keyUp(region, { key: ' ' });
  expect([canvas?.style.cursor, frame().style.pointerEvents]).toEqual(['', '']);
});

// One poll answered: a window focus asks at once (use-file-version.ts), and a macrotask lets its promise chain settle
async function poll(): Promise<void> {
  await act(async () => {
    fireEvent.focus(window);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

test('the first version is remembered and a repeat or a gone file changes nothing; a new one reloads the frame, and the ready after it shows the reloaded mark (#109)', async () => {
  render(pane());
  const first = await screen.findByTitle(NAME);
  await poll();
  await poll();
  version = null;
  await poll();
  fromFrame({ hive: 'design', type: 'ready' });
  expect(frame()).toBe(first);
  expect(screen.queryByTitle(/^recarregado/)).toBeNull();
  version = 'v2';
  await poll();
  const second = frame();
  expect(second).not.toBe(first);
  expect(second).toHaveAttribute('src', FRAME_URL);
  expect(screen.queryByTitle(/^recarregado/)).toBeNull(); // not before the new frame is ready
  fromFrame({ hive: 'design', type: 'ready' }, second.contentWindow);
  const mark = screen.getByTitle(/^recarregado · o agente alterou Landing\.hv\.html às \d{2}:\d{2}$/);
  expect(mark).toHaveTextContent(/^\d{2}:\d{2}$/);
});

test('the first version is read at once, so a change before the poll\'s first tick still reloads the frame (#109)', async () => {
  render(pane());
  const first = await screen.findByTitle(NAME);
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); }); // the immediate read settles: v1 is the baseline
  version = 'v2';
  await poll();
  expect(frame()).not.toBe(first);
});

test('a size past the cap is held to 100 000 px, so a design cannot choke the canvas (#109)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  fromFrame({ hive: 'design', type: 'size', height: 1e9 });
  expect(frame()).toHaveAttribute('height', '100000');
});

test('a pointer down on the canvas puts the focus in the pane, so ⌘0 and Space reach it (#109)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas]');
  if (canvas === null) throw new Error('no canvas');
  fireEvent.pointerDown(canvas);
  expect(document.activeElement).toBe(screen.getByRole('region', { name: LABEL }));
});

const local: Activity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [] };
const region = (): HTMLElement => screen.getByRole('region', { name: LABEL });
const panel = (): HTMLElement | null => screen.queryByRole('complementary', { name: 'comentários' });
// Off macOS (jsdom's platform): ⌘⇧↵ is Ctrl+Shift+Enter
const SEND_KEYS = { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true };

test('a task\'s pane shows the comments beside the canvas; the bar\'s button and the panel\'s × hide and show them; the button counts the open ones (#113)', async () => {
  const user = userEvent.setup();
  expect(REVIEW_PATH).toBe(PATH);
  review = REVIEW;
  render(pane());
  const button = screen.getByRole('button', { name: 'comentários' });
  await waitFor(() => expect(button).toHaveTextContent('4'));
  expect(button).toHaveAttribute('title', 'mostrar ou esconder os comentários');
  expect([button.getAttribute('aria-pressed'), panel() !== null]).toEqual(['true', true]);
  await user.click(button);
  expect([button.getAttribute('aria-pressed'), panel()]).toEqual(['false', null]);
  await user.click(button);
  expect(panel()).not.toBeNull();
  await user.click(within(panel() as HTMLElement).getByRole('button', { name: 'esconder' }));
  expect(panel()).toBeNull();
});

test('⌘⇧↵ in the pane sends this file\'s drafts to the recipient in one submit (#113)', async () => {
  review = REVIEW;
  render(pane());
  await screen.findByText('a draft');
  fireEvent.keyDown(region(), SEND_KEYS);
  const submits = fetchMock.mock.calls.filter(([url]) => url === '/tasks/I1/review/submit');
  expect(submits.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ skip: [], kind: 'design', path: PATH, to: 'new' }]);
});

test('a local activity\'s pane has no comments button nor panel, and reads no review (#113)', async () => {
  render(<DesignPane activity={local} path={PATH} label={LABEL} active />);
  await screen.findByTitle(NAME);
  expect(screen.queryByRole('button', { name: 'comentários' })).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/review'))).toBe(false);
});
