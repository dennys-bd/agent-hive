import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane } from '@/components/DesignPane';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { ReviewFile, Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';
import { area, PATH as REVIEW_PATH, REVIEW, stubScrollIntoView, unstubScrollIntoView } from './design-review';

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
// A block that declares viewports (#341): the switch shows only those, after natural
const declare = (viewports: string[]): void => fromFrame({ hive: 'design', type: 'tweaks', schema: { viewports } });
function frameWindow(): Window {
  const win = frame().contentWindow;
  if (win === null) throw new Error('the frame has no window');
  return win;
}

// What the pane posts to its frame from now on, by the message's type
function framePosts(): (type: string) => Record<string, unknown>[] {
  const spy = vi.spyOn(frameWindow(), 'postMessage').mockImplementation(() => undefined);
  return (type) => spy.mock.calls.map(([data]) => data as Record<string, unknown>).filter((data) => data.type === type);
}

beforeEach(() => {
  showCommentsPanel(false); // the state when the Hive opens (#241)
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
  unstubScrollIntoView();
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

test('tablet and mobile, once declared, set the frame to 768 and 390 px and refit; the theme goes to the frame on each ready and each toggle, and the Hive\'s stays (#109, #341)', async () => {
  const user = userEvent.setup();
  render(pane());
  await screen.findByTitle(NAME);
  declare(['desktop', 'tablet', 'mobile']);
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

test('a middle press on the canvas pans it with the pointer, the frame off the pointer and the cursor grabbing, until pointerup; a main press does not pan (#346)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas]');
  if (canvas === null) throw new Error('no canvas');
  Object.defineProperty(canvas, 'scrollLeft', { value: 100, writable: true });
  Object.defineProperty(canvas, 'scrollTop', { value: 50, writable: true });
  fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 200 });
  expect([canvas.style.cursor, frame().style.pointerEvents]).toEqual(['', '']);
  fireEvent.pointerDown(canvas, { button: 1, clientX: 200, clientY: 200 });
  expect([canvas.style.cursor, frame().style.pointerEvents]).toEqual(['grabbing', 'none']);
  fireEvent.pointerMove(window, { clientX: 170, clientY: 180 });
  expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([130, 70]);
  fireEvent.pointerUp(window, { button: 1 });
  fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });
  expect([canvas.scrollLeft, canvas.scrollTop, canvas.style.cursor, frame().style.pointerEvents]).toEqual([130, 70, '', '']);
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

test('at desktop the frame takes the content\'s reported width when wider, desktop\'s when narrower, and fits to it; a bad width keeps the last (#241)', async () => {
  const user = userEvent.setup();
  render(pane());
  await screen.findByTitle(NAME);
  declare(['desktop']);
  await user.click(screen.getByRole('radio', { name: 'desktop' }));
  fromFrame({ hive: 'design', type: 'size', height: 900, width: 1440 });
  expect([frame().getAttribute('width'), percent()]).toEqual(['1440', '44%']); // (672 − 32) / 1440
  fromFrame({ hive: 'design', type: 'size', height: 900, width: 600 });
  expect(frame()).toHaveAttribute('width', '1280');
  fromFrame({ hive: 'design', type: 'size', height: 700, width: 'wide' });
  expect([frame().getAttribute('width'), frame().getAttribute('height')]).toEqual(['1280', '700']);
});

test('a width reported at one viewport does not hold the next: mobile after a desktop load is 390, and an overflowing 1440 at desktop is 1440 (#241)', async () => {
  const user = userEvent.setup();
  render(pane());
  await screen.findByTitle(NAME);
  declare(['desktop', 'tablet', 'mobile']);
  await user.click(screen.getByRole('radio', { name: 'desktop' }));
  fromFrame({ hive: 'design', type: 'size', height: 900, width: 1280 });
  await user.click(screen.getByRole('radio', { name: 'mobile' }));
  expect(frame()).toHaveAttribute('width', '390');
  await user.click(screen.getByRole('radio', { name: 'desktop' }));
  fromFrame({ hive: 'design', type: 'size', height: 900, width: 1440 });
  expect(frame()).toHaveAttribute('width', '1440');
  await user.click(screen.getByRole('radio', { name: 'tablet' }));
  expect(frame()).toHaveAttribute('width', '768');
});

test('a pointer down on the canvas puts the focus in the pane, so ⌘0 and Space reach it (#109)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas]');
  if (canvas === null) throw new Error('no canvas');
  fireEvent.pointerDown(canvas);
  expect(document.activeElement).toBe(screen.getByRole('region', { name: LABEL }));
});

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
  expect([button.getAttribute('aria-pressed'), panel()]).toEqual(['false', null]); // closed when the Hive opens (#241)
  await user.click(button);
  expect([button.getAttribute('aria-pressed'), panel() !== null]).toEqual(['true', true]);
  await user.click(within(panel() as HTMLElement).getByRole('button', { name: 'esconder' }));
  expect(panel()).toBeNull();
});

test('⌘⇧↵ in the pane sends this file\'s drafts to the recipient in one submit (#113)', async () => {
  showCommentsPanel(true);
  review = REVIEW;
  render(pane());
  await screen.findByText('a draft');
  fireEvent.keyDown(region(), SEND_KEYS);
  const submits = fetchMock.mock.calls.filter(([url]) => url === '/tasks/I1/review/submit');
  expect(submits.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ skip: [], kind: 'design', path: PATH, to: 'new' }]);
});

test('⌘⇧↵ sends nothing while the comments panel is hidden (#113)', async () => {
  review = REVIEW;
  render(pane());
  await waitFor(() => expect(screen.getByRole('button', { name: 'comentários' })).toHaveTextContent('4'));
  fireEvent.keyDown(region(), SEND_KEYS);
  expect(fetchMock.mock.calls.filter(([url]) => url === '/tasks/I1/review/submit')).toEqual([]);
});

test('the comments panel starts closed and keeps the last choice across two mounted panes, by the bar\'s button or the panel\'s × (#241)', async () => {
  const user = userEvent.setup();
  review = REVIEW;
  render(<>{pane()}<DesignPane activity={activity} path={PATH} label="second" active /></>);
  const panels = (): HTMLElement[] => screen.queryAllByRole('complementary', { name: 'comentários' });
  const [first, second] = await screen.findAllByRole('button', { name: 'comentários' });
  expect([first.getAttribute('aria-pressed'), second.getAttribute('aria-pressed'), panels().length]).toEqual(['false', 'false', 0]);
  await user.click(first);
  expect([second.getAttribute('aria-pressed'), panels().length]).toEqual(['true', 2]);
  await user.click(within(panels()[1]).getByRole('button', { name: 'esconder' }));
  expect([first.getAttribute('aria-pressed'), panels().length]).toEqual(['false', 0]);
});

test('the comentar toggle and C post comment-mode and turn the canvas to a crosshair; C in a text field does nothing; the bridge\'s c and Esc reach the same mode (#114)', async () => {
  showCommentsPanel(true);
  const user = userEvent.setup();
  review = REVIEW;
  render(pane());
  await screen.findByTitle(NAME);
  await screen.findByText('a question');
  const posts = framePosts();
  const modes = (): unknown[] => posts('comment-mode').map((data) => data.on);
  const toggle = screen.getByRole('button', { name: 'comentar' });
  expect([toggle.getAttribute('aria-pressed'), toggle.getAttribute('title')]).toEqual(['false', 'comentar · C']);
  await user.click(toggle);
  expect([toggle.getAttribute('aria-pressed'), modes()]).toEqual(['true', [true]]);
  expect(document.querySelector<HTMLElement>('[data-design-canvas]')?.style.cursor).toBe('crosshair');
  fireEvent.keyDown(region(), { key: 'c' });
  expect(modes()).toEqual([true, false]);
  await user.click(screen.getByRole('button', { name: 'responder' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'responder' }), { key: 'c' });
  expect(modes()).toEqual([true, false]);
  fromFrame({ hive: 'design', type: 'key', key: 'c' });
  fromFrame({ hive: 'design', type: 'key', key: 'Escape' });
  expect(modes()).toEqual([true, false, true, false]);
});

test('after every ready the pane sends the file\'s comments, open and resolved, as anchors, and its comment mode (#114)', async () => {
  showCommentsPanel(true);
  review = REVIEW;
  render(pane());
  await screen.findByTitle(NAME);
  await screen.findByText('a draft');
  const posts = framePosts();
  fromFrame({ hive: 'design', type: 'ready' });
  const ids: [string, number][] = [['T2', 2], ['T3', 3], ['T4', 4], ['D5', 5], ['T1', 1], ['T6', 6]];
  expect(posts('anchors')).toEqual([{ hive: 'design', type: 'anchors', anchors: ids.map(([id, pin]) => ({ id, anchor: area(pin) })) }]);
  expect(posts('comment-mode')).toEqual([{ hive: 'design', type: 'comment-mode', on: false }]);
});

test('an item click posts scroll-to with its id, and the pins after it scroll the canvas to that pin (#114)', async () => {
  showCommentsPanel(true);
  const user = userEvent.setup();
  review = REVIEW;
  const scrolled = stubScrollIntoView();
  render(pane());
  await screen.findByTitle(NAME);
  await screen.findByText('with the agent');
  const posts = framePosts();
  await user.click(screen.getByText('with the agent'));
  expect(posts('scroll-to')).toEqual([{ hive: 'design', type: 'scroll-to', id: 'T4' }]);
  expect(scrolled).not.toHaveBeenCalled();
  fromFrame({ hive: 'design', type: 'pins', pins: [{ id: 'T4', rect: { x: 10, y: 20, width: 100, height: 30 } }] });
  expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
  expect(scrolled.mock.contexts).toEqual([screen.getByRole('button', { name: 'comentário 4' })]);
});

test('an item whose rect came back null shows elemento removido; one with no answer yet shows nothing (#114)', async () => {
  showCommentsPanel(true);
  review = REVIEW;
  render(pane());
  await screen.findByTitle(NAME);
  await screen.findByText('a question');
  expect(screen.queryByText('elemento removido')).toBeNull();
  fromFrame({ hive: 'design', type: 'pins', pins: [{ id: 'T2', rect: null }, { id: 'T4', rect: { x: 0, y: 40, width: 10, height: 10 } }] });
  const removed = screen.getAllByText('elemento removido');
  expect(removed).toHaveLength(1);
  expect(removed[0].closest('li')).toHaveTextContent('a question');
  expect(removed[0]).toHaveClass('text-muted-foreground');
});

test('a pan from the frame takes the frame off the pointer and pans the canvas from the first move until pointerup; a zoom from the frame zooms; the same from another source, or out of shape, are dropped (#346)', async () => {
  render(pane());
  await screen.findByTitle(NAME);
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas]');
  if (canvas === null) throw new Error('no canvas');
  Object.defineProperty(canvas, 'scrollLeft', { value: 0, writable: true });
  Object.defineProperty(canvas, 'scrollTop', { value: 0, writable: true });
  fromFrame({ hive: 'design', type: 'pan' }, window); // not this pane's frame
  fromFrame({ type: 'pan' });
  expect(frame().style.pointerEvents).toBe('');
  fromFrame({ hive: 'design', type: 'pan' });
  expect([canvas.style.cursor, frame().style.pointerEvents]).toEqual(['grabbing', 'none']);
  fireEvent.pointerMove(window, { clientX: 300, clientY: 300 }); // the start: the frame's press has no position the pane can read
  fireEvent.pointerMove(window, { clientX: 280, clientY: 290 });
  expect([canvas.scrollLeft, canvas.scrollTop]).toEqual([20, 10]);
  fireEvent.pointerUp(window, { button: 1 });
  expect([canvas.style.cursor, frame().style.pointerEvents]).toEqual(['', '']);
  fromFrame({ hive: 'design', type: 'zoom', deltaY: -10, x: 100, y: 100 }, window);
  fromFrame({ hive: 'design', type: 'zoom', deltaY: '-10', x: 100, y: 100 });
  fromFrame({ hive: 'design', type: 'zoom', deltaY: -10, x: Number.NaN, y: 100 });
  fromFrame({ hive: 'design', type: 'zoom', deltaY: -10, x: 100 });
  fromFrame({ type: 'zoom', deltaY: -10, x: 100, y: 100 });
  expect(percent()).toBe('50%');
  fromFrame({ hive: 'design', type: 'zoom', deltaY: -10, x: 100, y: 100 });
  expect(percent()).toBe('55%'); // 50 × e^0.1
});
