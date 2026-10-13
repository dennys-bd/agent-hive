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

test('the bridge posts ready and the height and width on load, then each new size, and applies a theme only from its parent in the protocol\'s shape (#108)', () => {
  let observed: () => void = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observed = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  const { sent } = harness();
  const root = document.documentElement;
  const size = (height: number, width: number, client = 1280): void => {
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: height });
    Object.defineProperty(root, 'scrollWidth', { configurable: true, value: width });
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: client });
  };
  size(640, 1280);
  start();
  window.dispatchEvent(new Event('load'));
  size(900, 1280);
  observed();
  observed(); // the same size: nothing new
  size(900, 1440); // a window screen wider than the viewport (#241)
  observed();
  size(900, 1440, 768); // the frame narrowed: the same overflow is news again
  observed();
  expect(sent()).toEqual([
    { hive: 'design', type: 'ready' }, { hive: 'design', type: 'size', height: 640 }, // content that fits reports no width: the frame's own is not a wish
    { hive: 'design', type: 'size', height: 900 }, { hive: 'design', type: 'size', height: 900, width: 1440 },
    { hive: 'design', type: 'size', height: 900, width: 1440 },
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

test('in comment mode a hover outlines, a click posts an element anchor and the design\'s own handler never runs, a drag of 4 px or more posts an area anchor; off, neither (#112)', () => {
  const { sent } = harness();
  vi.stubGlobal('scrollY', 100);
  document.body.innerHTML = '<main><button id="buy">Buy</button></main>';
  const buy = document.getElementById('buy')!;
  vi.spyOn(buy, 'getBoundingClientRect').mockReturnValue(box(10, 20, 80, 30));
  const designClick = vi.fn();
  buy.addEventListener('click', designClick);
  start();
  const mouse = (type: string, x: number, y: number, target: Element = buy): boolean =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  mouse('mousedown', 15, 25);
  mouse('mouseup', 15, 25);
  mouse('click', 15, 25);
  mouse('mousedown', 0, 0);
  mouse('mousemove', 40, 30);
  mouse('mouseup', 40, 30);
  expect(sent()).toEqual([]);
  expect(designClick).toHaveBeenCalledTimes(1);
  design({ type: 'comment-mode', on: true });
  expect(document.documentElement.style.cursor).toBe('crosshair');
  const outline = document.querySelector<HTMLElement>('[data-hive="outline"]')!;
  const area = document.querySelector<HTMLElement>('[data-hive="area"]')!;
  mouse('mousedown', 15, 25);
  mouse('mousemove', 17, 27); // under 4 px: a hover, not a drag
  expect([outline.style.display, outline.style.left, outline.style.top]).toEqual(['block', '10px', '20px']);
  mouse('mouseup', 17, 27);
  expect(mouse('click', 17, 27)).toBe(false);
  mouse('mousedown', 0, 0, document.body);
  mouse('mousemove', 3, 0, document.body);
  mouse('mousemove', 40, 30, document.body);
  expect([outline.style.display, area.style.display, area.style.top, area.style.width]).toEqual(['none', 'block', '0px', '40px']);
  mouse('mouseup', 40, 30, document.body);
  mouse('click', 40, 30, document.body); // the click a drag ends with anchors nothing
  const right = (type: string, x: number, y: number): boolean =>
    document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  right('mousedown', 0, 0);
  mouse('mousemove', 40, 30, document.body);
  right('mouseup', 40, 30); // a secondary button draws no area
  expect(designClick).toHaveBeenCalledTimes(1);
  expect(sent()).toEqual([
    { hive: 'design', type: 'anchor', anchor: { kind: 'element', selector: '#buy', text: 'Buy', rect: { x: 10, y: 120, width: 80, height: 30 } } },
    { hive: 'design', type: 'anchor', anchor: { kind: 'area', rect: { x: 0, y: 100, width: 40, height: 30 } } },
  ]);
  design({ type: 'comment-mode', on: false });
  expect(document.querySelectorAll('[data-hive]')).toHaveLength(0);
  expect(document.documentElement.style.cursor).toBe('');
});

test('c and Escape are forwarded, Escape\'s default prevented only in comment mode; never from an editable field or with a modifier (#112)', () => {
  const { sent } = harness();
  document.body.innerHTML = '<input id="field"><p>Text</p>';
  start();
  const key = (name: string, target: Element = document.body, init: KeyboardEventInit = {}): boolean =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  expect(key('c')).toBe(true);
  expect(key('Escape')).toBe(true);
  key('x');
  key('c', document.getElementById('field')!);
  key('c', document.body, { metaKey: true });
  key('Escape', document.body, { shiftKey: true });
  design({ type: 'comment-mode', on: true });
  expect(key('Escape')).toBe(false);
  expect(sent()).toEqual([
    { hive: 'design', type: 'key', key: 'c' }, { hive: 'design', type: 'key', key: 'Escape' }, { hive: 'design', type: 'key', key: 'Escape' },
  ]);
});

test('on load, after ready, the bridge posts the hv-tweaks block raw, or a json error when it does not parse; no block, no tweaks message (#241)', () => {
  const { sent } = harness();
  const loadWith = (html: string): unknown[] => {
    for (const stop of stops) stop();
    stops = [];
    document.body.innerHTML = html;
    start();
    const before = sent().length;
    window.dispatchEvent(new Event('load'));
    return sent().slice(before).filter((data) => (data as { type: string }).type !== 'size');
  };
  const block = (text: string): string => `<script type="application/json" id="hv-tweaks">${text}</script>`;
  expect(loadWith(block('{"layout":{"options":["board","list"],"default":"board"}}'))).toEqual([
    { hive: 'design', type: 'ready' }, { hive: 'design', type: 'tweaks', schema: { layout: { options: ['board', 'list'], default: 'board' } } },
  ]);
  expect(loadWith(block('{"layout":'))).toEqual([{ hive: 'design', type: 'ready' }, { hive: 'design', type: 'tweaks', schema: null, error: 'json' }]);
  expect(loadWith('<p>no block</p>')).toEqual([{ hive: 'design', type: 'ready' }]);
});

test('a tweak from the parent sets data-tweak-<name> on the root and fires hv:tweak; a bad name, a bad value or another source changes nothing (#241)', () => {
  harness();
  start();
  const root = document.documentElement;
  const fired = vi.fn();
  window.addEventListener('hv:tweak', fired);
  design({ type: 'tweak', name: 'layout', value: 'board' });
  design({ type: 'tweak', name: 'auto', value: true });
  design({ type: 'tweak', name: 'gap', value: 12.5 });
  design({ type: 'tweak', name: 'Bad', value: 'x' });
  design({ type: 'tweak', name: 'a b', value: 'x' });
  design({ type: 'tweak', name: 'ok', value: { a: 1 } });
  design({ type: 'tweak', name: 'nan', value: Number.NaN });
  message({ hive: 'design', type: 'tweak', name: 'layout', value: 'list' }, null);
  expect([root.getAttribute('data-tweak-layout'), root.getAttribute('data-tweak-auto'), root.getAttribute('data-tweak-gap')]).toEqual(['board', 'true', '12.5']);
  expect([root.hasAttribute('data-tweak-ok'), root.hasAttribute('data-tweak-nan')]).toEqual([false, false]);
  expect(fired.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([{ name: 'layout', value: 'board' }, { name: 'auto', value: true }, { name: 'gap', value: 12.5 }]);
  window.removeEventListener('hv:tweak', fired);
  for (const name of ['layout', 'auto', 'gap']) root.removeAttribute(`data-tweak-${name}`);
});
