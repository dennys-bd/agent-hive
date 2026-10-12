import { expect, test, vi } from 'vitest';
import { bridgeScript } from '../../src/design-bridge';

// The real script, through the same transform as the app's tests: a function left out of the join, or a helper a transform puts into
// a function body, is unbound here. Its own file: the joined bridge cannot be torn down, and vitest gives each file a fresh window.
test('the real bridgeScript body runs in jsdom with every function it reaches joined in: no ReferenceError (#112)', () => {
  const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { frames = [...frames, callback]; return frames.length; });
  const flush = (): void => {
    const due = frames;
    frames = [];
    for (const callback of due) callback(0);
  };
  const errors: unknown[] = [];
  window.addEventListener('error', (event) => { errors.push(event.error); });
  const design = (data: Record<string, unknown>): void => {
    window.dispatchEvent(new MessageEvent('message', { data: { hive: 'design', ...data }, source: window }));
  };
  document.body.innerHTML = '<main><p>Hello</p></main>';
  const script = bridgeScript();
  new Function(script.slice('<script>'.length, -'</script>'.length))();
  const rect = { x: 0, y: 0, width: 0, height: 0 };
  design({ type: 'anchors', anchors: [
    { id: 'a', anchor: { kind: 'element', selector: 'body > main:nth-of-type(1) > p:nth-of-type(1)', text: 'Hello', rect } },
    { id: 'b', anchor: { kind: 'element', selector: 'body > p:nth-of-type(1)', text: 'Nope', rect } }, // every step runs, none finds it
  ] });
  flush();
  design({ type: 'scroll-to', id: 'a' });
  flush();
  const pins = { hive: 'design', type: 'pins', pins: [{ id: 'a', rect }, { id: 'b', rect: null }] };
  expect(errors).toEqual([]);
  expect(posted.mock.calls.map(([data]) => data)).toEqual([pins, pins]);
});
