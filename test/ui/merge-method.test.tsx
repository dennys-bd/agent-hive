import { expect, test } from 'vitest';
import { MERGE_METHOD_KEY, pickMethod, rememberMethod } from '@/lib/merge-method';
import { PR } from './pr-harness';

test('mergear\'s method: the one remembered for the repository while it allows it, else the first allowed of squash, merge, rebase (#592)', () => {
  localStorage.clear();
  expect(pickMethod(PR, ['merge', 'rebase'])).toBe('merge');
  expect(pickMethod(PR, ['rebase', 'squash', 'merge'])).toBe('squash');
  rememberMethod(PR, 'rebase');
  expect(JSON.parse(localStorage.getItem(MERGE_METHOD_KEY) ?? '')).toEqual({ 'acme/app': 'rebase' });
  expect(pickMethod(PR, ['squash', 'rebase'])).toBe('rebase');
  expect(pickMethod(PR, ['squash'])).toBe('squash');
  expect(pickMethod('https://github.com/other/repo/pull/1', ['merge', 'rebase'])).toBe('merge');
  expect(pickMethod(PR, [])).toBeUndefined();
  localStorage.setItem(MERGE_METHOD_KEY, 'not json');
  expect(pickMethod(PR, ['merge'])).toBe('merge');
});
