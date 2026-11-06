import { beforeEach, expect, test } from 'vitest';
import { trashMessage } from '@/components/tree-menus';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('pt'));

test('delete\'s question names one item by its last segment, a Windows path\'s included; two by their count; none asks nothing (#641, #818)', () => {
  expect(trashMessage(['C:\\repo\\src\\a.ts'])).toBe(t('files.trashOne', { name: 'a.ts' }));
  expect(trashMessage(['src/a.ts'])).toBe(t('files.trashOne', { name: 'a.ts' }));
  expect(trashMessage(['a', 'b'])).toBe(t('files.trashMany', { n: 2 }));
  expect(trashMessage(undefined)).toBe('');
});
