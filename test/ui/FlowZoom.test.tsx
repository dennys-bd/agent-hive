import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FlowZoom, ZOOM_WAKE_MS } from '@/components/FlowZoom';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// The wrapper of − 100% + and ajustar: the number's group's parent
const controls = (): HTMLElement => screen.getByRole('button', { name: /^\d+%$/ }).parentElement!.parentElement!;
const zoomAt = (zoom: number) => <FlowZoom zoom={zoom} onZoom={() => undefined} onFit={() => undefined} />;

test('the zoom controls open at 30% and come back to full on hover and on keyboard focus, not on a click\'s focus (#81)', () => {
  render(zoomAt(1));
  expect(controls()).toHaveClass('opacity-30', 'transition-opacity', 'hover:opacity-100', 'has-[:focus-visible]:opacity-100');
  expect(controls().className).not.toContain('focus-within');
});

test('a zoom change lights the controls for 1.5 s, a second one inside it starts the count again, and an unmount leaves no timer (#81)', () => {
  const { rerender, unmount } = render(zoomAt(1));
  rerender(zoomAt(1.1));
  expect(controls()).not.toHaveClass('opacity-30');
  act(() => { vi.advanceTimersByTime(ZOOM_WAKE_MS - 500); });
  rerender(zoomAt(1.2));
  act(() => { vi.advanceTimersByTime(ZOOM_WAKE_MS - 1); });
  expect(controls()).not.toHaveClass('opacity-30');
  act(() => { vi.advanceTimersByTime(1); });
  expect(controls()).toHaveClass('opacity-30');
  rerender(zoomAt(1.3));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
