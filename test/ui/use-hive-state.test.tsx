import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useHiveState } from '@/hooks/use-hive-state';
import { onConsoleChange } from '@/lib/console-events';
import { onEditorInstall } from '@/lib/editor-install-events';
import { onPrReviewEvent, onReviewEvent } from '@/lib/review-events';

class FakeSource {
  static last: FakeSource | undefined;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen = null; onmessage = null; onerror = null;
  constructor() { FakeSource.last = this; }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void { this.listeners[type] = listener; }
  close(): void {}
}
afterEach(() => vi.unstubAllGlobals());

test('a named review event reaches the review listeners with its task, never the State (#591)', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const heard = vi.fn();
  const stop = onReviewEvent(heard);
  const { result } = renderHook(() => useHiveState());
  FakeSource.last?.listeners.review?.(new MessageEvent('review', { data: '{"type":"review","taskId":"I1"}' }));
  expect(heard).toHaveBeenCalledWith('I1');
  expect(result.current.state).toBeUndefined();
  stop();
});

test('a named prReview event reaches the PR listeners with its link, never the State (#592)', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const heard = vi.fn();
  const stop = onPrReviewEvent(heard);
  const { result } = renderHook(() => useHiveState());
  FakeSource.last?.listeners.prReview?.(new MessageEvent('prReview', { data: '{"type":"prReview","url":"https://github.com/acme/app/pull/7"}' }));
  expect(heard).toHaveBeenCalledWith('https://github.com/acme/app/pull/7');
  expect(result.current.state).toBeUndefined();
  stop();
});

test('an editorInstall event reaches the install listeners (#780)', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const heard = vi.fn();
  const stop = onEditorInstall(heard);
  renderHook(() => useHiveState());
  const event = { kind: 'server', id: 'pyright', state: { state: 'absent' } };
  FakeSource.last?.listeners.editorInstall?.(new MessageEvent('editorInstall', { data: JSON.stringify(event) }));
  expect(heard).toHaveBeenCalledWith(event);
  stop();
});

test('a console event reaches the console listeners, never the State (#780)', () => {
  vi.stubGlobal('EventSource', FakeSource);
  const heard = vi.fn();
  const stop = onConsoleChange(heard);
  const { result } = renderHook(() => useHiveState());
  FakeSource.last?.listeners.console?.(new MessageEvent('console', { data: '{"type":"console"}' }));
  expect(heard).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBeUndefined();
  stop();
});
