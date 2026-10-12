import { afterEach, expect, test, vi } from 'vitest';
import { elementAnchor, findAnchor, isAnchorList, isEditable, pinRects } from '../../src/design-anchor';
import { designBridge } from '../../src/design-bridge';

const HELPERS = { elementAnchor, findAnchor, pinRects, isEditable, isAnchorList };
let stops: (() => void)[] = [];
// Every bridge listens on the one window of this file: each test's bridge is torn down after it
const start = (): void => { stops = [...stops, designBridge(HELPERS)]; };

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const message = (data: unknown, source: Window | null = window): void => { window.dispatchEvent(new MessageEvent('message', { data, source })); };
const design = (data: Record<string, unknown>): void => message({ hive: 'design', ...data });
const box = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

// The bridge's posts, and its animation frames run on demand
function harness(): { sent: () => unknown[]; flush: () => void } {
  const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { frames = [...frames, callback]; return frames.length; });
  return {
    sent: () => posted.mock.calls.map(([data]) => data),
    flush: () => {
      const due = frames;
      frames = [];
      for (const callback of due) callback(0);
    },
  };
}

test('the bridge posts ready and the height on load, then each new height, and applies a theme only from its parent in the protocol\'s shape (#108)', () => {
  let observed: () => void = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observed = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  const { sent } = harness();
  const root = document.documentElement;
  const height = (px: number): void => { Object.defineProperty(root, 'scrollHeight', { configurable: true, value: px }); };
  height(640);
  start();
  window.dispatchEvent(new Event('load'));
  height(900);
  observed();
  observed(); // the same height: nothing new
  expect(sent()).toEqual([
    { hive: 'design', type: 'ready' }, { hive: 'design', type: 'size', height: 640 }, { hive: 'design', type: 'size', height: 900 },
  ]);
  message({ hive: 'design', type: 'theme', theme: 'light' }, null); // not from the parent
  message({ hive: 'design', type: 'theme', theme: 'blue' });
  message({ type: 'theme', theme: 'light' });
  expect(root.dataset.theme).toBeUndefined();
  message({ hive: 'design', type: 'theme', theme: 'light' });
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(['light', 'light']);
});

test('comment-mode, anchors and scroll-to from a source other than the parent, or out of shape, are ignored (#112)', () => {
  const { sent, flush } = harness();
  document.body.innerHTML = '<p id="x">Hi</p>';
  const p = document.getElementById('x')!;
  const scrolled = vi.spyOn(p, 'scrollIntoView');
  start();
  design({ type: 'anchors', anchors: [{ id: 'a', anchor: elementAnchor(p) }] });
  flush();
  const pins = { hive: 'design', type: 'pins', pins: [{ id: 'a', rect: { x: 0, y: 0, width: 0, height: 0 } }] };
  expect(sent()).toEqual([pins]);
  message({ hive: 'design', type: 'comment-mode', on: true }, null);
  message({ hive: 'design', type: 'anchors', anchors: [] }, null);
  message({ hive: 'design', type: 'scroll-to', id: 'a' }, null);
  design({ type: 'anchors', anchors: [{ id: 'b', anchor: { kind: 'circle' } }] });
  design({ type: 'comment-mode', on: 'yes' });
  flush();
  expect(sent()).toEqual([pins]);
  expect(document.documentElement.style.cursor).toBe('');
  expect(scrolled).not.toHaveBeenCalled();
});

test('comment-mode on sets the crosshair on the frame\'s root, and off restores the cursor it had (#112)', () => {
  harness();
  const root = document.documentElement;
  root.style.cursor = 'help';
  start();
  design({ type: 'comment-mode', on: true });
  expect(root.style.cursor).toBe('crosshair');
  design({ type: 'comment-mode', on: false });
  expect(root.style.cursor).toBe('help');
  root.style.cursor = '';
});

test('anchors answers pins in one frame, a scroll anywhere answers them again, and scroll-to scrolls to the anchor first (#112)', () => {
  const { sent, flush } = harness();
  vi.stubGlobal('scrollY', 100);
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  document.body.innerHTML = '<h2 id="title">Plans</h2><div id="inner"></div>';
  const title = document.getElementById('title')!;
  vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(box(20, 30, 200, 40));
  const scrolled = vi.spyOn(title, 'scrollIntoView');
  start();
  const anchors = [
    { id: 'a', anchor: { kind: 'element', selector: '#title', text: 'Plans', rect: { x: 20, y: 130, width: 200, height: 40 } } },
    { id: 'b', anchor: { kind: 'area', rect: { x: 600, y: 500, width: 200, height: 100 } } },
    { id: 'c', anchor: { kind: 'element', selector: '#gone', text: 'Gone', rect: { x: 0, y: 0, width: 10, height: 10 } } },
  ];
  design({ type: 'anchors', anchors });
  design({ type: 'anchors', anchors }); // two in one frame: one report
  flush();
  const pins = { hive: 'design', type: 'pins', pins: [
    { id: 'a', rect: { x: 20, y: 30, width: 200, height: 40 } },
    { id: 'b', rect: { x: 600, y: 400, width: 200, height: 100 } },
    { id: 'c', rect: null },
  ] };
  expect(sent()).toEqual([pins]);
  document.getElementById('inner')!.dispatchEvent(new Event('scroll')); // an inner scroller: scroll does not bubble, capture still sees it
  flush();
  expect(sent()).toEqual([pins, pins]);
  design({ type: 'scroll-to', id: 'a' });
  design({ type: 'scroll-to', id: 'b' });
  design({ type: 'scroll-to', id: 'nope' });
  flush();
  expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
  expect(scrollTo).toHaveBeenCalledWith({ left: 300, top: 250 });
  expect(sent()).toEqual([pins, pins, pins]);
});
