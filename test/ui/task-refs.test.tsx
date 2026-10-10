import { expect, test } from 'vitest';
import { findTaskRefs, refPrefixes } from '@/lib/task-refs';
import type { SourceConfig } from '../../src/types';

test('findTaskRefs: #N in prose, with its span; never right after a word character, nor running into one (#588)', () => {
  expect(findTaskRefs('fixed in #576, see (#12).', [])).toEqual([{ ref: '#576', start: 9, end: 13 }, { ref: '#12', start: 20, end: 23 }]);
  expect(findTaskRefs('abc#1, x#2 and #3abc', [])).toEqual([]);
  expect(findTaskRefs('https://x/page#123 and ?id=#4', []), 'a URL fragment or a query value is no reference').toEqual([]);
});

test('findTaskRefs: PREFIX-N only for a known prefix, on word boundaries and case-sensitive, a prefix\'s regex characters taken literally (#588)', () => {
  const text = 'HIVE-11 done, UTF-8 and ISO-8601 stay text; GH-3.';
  const found = findTaskRefs(text, ['HIVE', 'GH']);
  expect(found).toEqual([{ ref: 'HIVE-11', start: 0, end: 7 }, { ref: 'GH-3', start: 44, end: 48 }]);
  expect(findTaskRefs('FOO-HIVE-11', ['HIVE']), 'a prefix inside a longer hyphenated name').toEqual([]);
  expect(found.map(({ start, end }) => text.slice(start, end))).toEqual(['HIVE-11', 'GH-3']);
  expect(findTaskRefs('xHIVE-1 hive-1-spec HIVE-', ['HIVE'])).toEqual([]);
  expect(findTaskRefs('my.site-4 myXsite-4', ['my.site'])).toEqual([{ ref: 'my.site-4', start: 0, end: 9 }]);
});

test('refPrefixes: the Comb\'s prefix, then each qualifyId source\'s prefix, or its name without one; a source without qualifyId adds none (#588)', () => {
  const source = (name: string, qualifyId: boolean, prefix?: string): SourceConfig => ({
    type: 'github', owner: 'acme', number: 1, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, name, qualifyId, ...(prefix === undefined ? {} : { prefix }),
  });
  expect(refPrefixes({ comb: { prefix: 'HIVE', sources: [source('gh', true, 'GH'), source('notes', true), source('plain', false)] } })).toEqual(['HIVE', 'GH', 'notes']);
});
