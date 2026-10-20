import { fireEvent, renderHook } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { useBackKeys } from '@/hooks/use-back-keys';

const BACK_KEY = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }; // goBack off macOS: jsdom is not macOS
const MOUSE_BACK = { button: 3 }; // the mouse's back side button, as Electron on macOS reports it

test('⌘[ and the mouse\'s back button call back while it is given, and nothing once it is not (#911)', () => {
  const onBack = vi.fn();
  const { rerender } = renderHook(({ back }) => useBackKeys(back), { initialProps: { back: onBack as (() => void) | undefined } });
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(false); // handled: the default is prevented
  expect(fireEvent.mouseUp(window, MOUSE_BACK)).toBe(false);
  expect(onBack).toHaveBeenCalledTimes(2);
  rerender({ back: undefined }); // no back button shows
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(true);
  fireEvent.mouseUp(window, MOUSE_BACK);
  expect(onBack).toHaveBeenCalledTimes(2);
});

test('goBack does not act with the focus in a text field: Alt+Left moves by word there (#911)', () => {
  const onBack = vi.fn();
  renderHook(() => useBackKeys(onBack));
  const field = document.body.appendChild(document.createElement('textarea'));
  onTestFinished(() => field.remove());
  fireEvent.keyDown(field, BACK_KEY);
  expect(onBack).not.toHaveBeenCalled();
  fireEvent.keyDown(window, BACK_KEY);
  expect(onBack).toHaveBeenCalledOnce();
});
