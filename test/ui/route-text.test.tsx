import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { filterSentence, opWord } from '@/lib/route-text';

beforeEach(() => setLanguage('pt'));

test('filterSentence: one sentence per criterion and op, several values joined by ou/or', () => {
  expect(filterSentence('site', { field: 'label', op: 'any', values: ['site'] })).toBe('a source site só pega issues com a label site');
  expect(filterSentence('site', { field: 'label', op: 'none', values: ['a', 'b'] })).toBe('a source site não pega issues com a label a ou b');
  expect(filterSentence('s', { field: 'milestone', op: 'any', values: ['v1'] })).toBe('a source s só pega issues no milestone v1');
  expect(filterSentence('s', { field: 'repository', op: 'none', values: ['a/b'] })).toBe('a source s não pega issues do repositório a/b');
  expect(filterSentence('s', { field: 'projectField', name: 'Size', op: 'any', values: ['S', 'M'] })).toBe('a source s só pega issues com Size S ou M');
  expect(filterSentence('s', { field: 'blocked', op: 'any' })).toBe('a source s só pega issues bloqueadas');
  expect(filterSentence('s', { field: 'blocked', op: 'none' })).toBe('a source s não pega issues bloqueadas');
  expect(filterSentence('s', { field: 'assignee', op: 'any', values: ['@me'] })).toBe('a source s só pega issues atribuídas a @me');
  setLanguage('en');
  expect(filterSentence('site', { field: 'label', op: 'any', values: ['x', 'y'] })).toBe('the source site only takes issues with the label x or y');
});

test('opWord maps the four rule ops to Settings words', () => {
  expect(['equals', 'iequals'].map((o) => opWord(o as 'equals'))).toEqual(['é igual a', 'é igual a']);
  expect(['contains', 'icontains'].map((o) => opWord(o as 'contains'))).toEqual(['contém', 'contém']);
});
