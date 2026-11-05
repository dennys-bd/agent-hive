import { afterEach, expect, test, vi } from 'vitest';
import { isWindows } from '@/lib/shortcut-bindings';

afterEach(() => vi.restoreAllMocks());

test('isWindows is true for a Windows navigator and false for macOS, Linux and jsdom\'s empty platform (#648)', () => {
  expect(isWindows()).toBe(false); // jsdom's ''
  for (const [platform, expected] of [['Win32', true], ['MacIntel', false], ['Linux x86_64', false]] as const) {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    expect(isWindows(), platform).toBe(expected);
  }
});
