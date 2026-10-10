import { afterEach, expect, test, vi } from 'vitest';
import { applyTheme, resolveTheme } from '@/lib/theme';

type Listener = (event: MediaQueryListEvent) => void;

// A matchMedia whose dark preference the test flips: a change reaches only the listeners still subscribed.
function fakeDarkQuery(matches: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches,
    addEventListener: vi.fn((_type: string, listener: Listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: Listener) => listeners.delete(listener)),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  const flip = (dark: boolean): void => {
    query.matches = dark;
    for (const listener of listeners) listener({ matches: dark } as MediaQueryListEvent);
  };
  return { query, flip };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

test('resolveTheme: system follows the macOS preference, light and dark ignore it (#296)', () => {
  const themes = ['system', 'light', 'dark'] as const;
  expect([true, false].flatMap((dark) => themes.map((theme) => resolveTheme(theme, dark)))).toEqual(['dark', 'light', 'dark', 'light', 'light', 'dark']);
});

test('applyTheme(system) sets data-theme from macOS, follows a change live and stops after the unsubscribe (#296)', () => {
  const { flip } = fakeDarkQuery(true);
  const seen: string[] = [];
  const stop = applyTheme('system', (resolved) => seen.push(resolved));
  expect(document.documentElement.dataset.theme).toBe('dark');
  flip(false);
  expect(document.documentElement.dataset.theme).toBe('light');
  stop();
  flip(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(seen).toEqual(['dark', 'light']);
});

test('applyTheme(light) forces light over a dark macOS and never subscribes (#296)', () => {
  const { query } = fakeDarkQuery(true);
  const seen: string[] = [];
  applyTheme('light', (resolved) => seen.push(resolved))();
  expect([document.documentElement.dataset.theme, seen]).toEqual(['light', ['light']]);
  expect(query.addEventListener).not.toHaveBeenCalled();
});
