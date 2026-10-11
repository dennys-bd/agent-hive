import { afterEach, expect, test, vi } from 'vitest';
import { designBridge } from '../../src/design-bridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the bridge posts ready and the height on load, then each new height, and applies a theme only from its parent in the protocol\'s shape (#108)', () => {
  let observed: () => void = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observed = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const root = document.documentElement;
  const height = (px: number): void => { Object.defineProperty(root, 'scrollHeight', { configurable: true, value: px }); };
  height(640);
  designBridge();
  window.dispatchEvent(new Event('load'));
  height(900);
  observed();
  observed(); // the same height: nothing new
  expect(posted.mock.calls.map(([message]) => message)).toEqual([
    { hive: 'design', type: 'ready' }, { hive: 'design', type: 'size', height: 640 }, { hive: 'design', type: 'size', height: 900 },
  ]);
  const message = (data: unknown, source: Window | null = window): void => { window.dispatchEvent(new MessageEvent('message', { data, source })); };
  message({ hive: 'design', type: 'theme', theme: 'light' }, null); // not from the parent
  message({ hive: 'design', type: 'theme', theme: 'blue' });
  message({ type: 'theme', theme: 'light' });
  expect(root.dataset.theme).toBeUndefined();
  message({ hive: 'design', type: 'theme', theme: 'light' });
  expect([root.dataset.theme, root.style.colorScheme]).toEqual(['light', 'light']);
});
