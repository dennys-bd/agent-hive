import { afterEach, expect, test, vi } from 'vitest';
import { listenFrameKeys, onPanelKey } from '@/lib/dock-layout';
import type { KeyLike } from '../../src/shortcuts';

// window.hive as the preload exposes it: the one listener window:frameKey calls, and its unsubscribe
function fakeBridge() {
  let listener: ((key: KeyLike) => void) | undefined;
  const off = vi.fn();
  vi.stubGlobal('hive', { onFrameKey: vi.fn((callback: (key: KeyLike) => void) => { listener = callback; return off; }) });
  return { off, send: (key: KeyLike): void => listener?.(key) };
}
// The design pane's or draw.io's frame with the focus in it: document.activeElement is the <iframe> element
function focusedFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  frame.focus();
  return frame;
}
// toggleLeft off macOS (jsdom's platform is ''): Ctrl+Shift+B, as main sends it from a focused frame
const TOGGLE_LEFT: KeyLike = { key: 'B', code: 'KeyB', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('listenFrameKeys dispatches each key main sends as a keydown on the focused iframe, bubbling and cancelable; its unsubscribe is the bridge\'s (#906)', () => {
  const bridge = fakeBridge();
  const frame = focusedFrame();
  expect(document.activeElement).toBe(frame);
  const seen: KeyboardEvent[] = [];
  const record = (event: KeyboardEvent): void => { seen.push(event); };
  window.addEventListener('keydown', record, true);
  const off = listenFrameKeys();
  bridge.send(TOGGLE_LEFT);
  window.removeEventListener('keydown', record, true);
  expect(seen.map((e) => [e.target, e.key, e.code, e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, e.bubbles, e.cancelable]))
    .toEqual([[frame, 'B', 'KeyB', false, true, false, true, true, true]]);
  off();
  expect(bridge.off).toHaveBeenCalledTimes(1);
});

test('onPanelKey\'s toggle runs for its key from a focused iframe, through the window\'s capture listener, which prevents it there (#906)', () => {
  const bridge = fakeBridge();
  const frame = focusedFrame();
  const toggle = vi.fn();
  const offPanel = onPanelKey(toggle);
  const offFrame = listenFrameKeys();
  let isPrevented = false;
  frame.addEventListener('keydown', (event) => { isPrevented = event.defaultPrevented; });
  bridge.send(TOGGLE_LEFT);
  expect(toggle).toHaveBeenCalledWith('left');
  expect(isPrevented).toBe(false); // stopped on window's capture phase: the frame's own listener never sees it
  offPanel();
  offFrame();
});

test('a plain browser has no bridge: listenFrameKeys subscribes to nothing and its unsubscribe does nothing (#906)', () => {
  vi.stubGlobal('hive', undefined);
  expect(() => listenFrameKeys()()).not.toThrow();
});
