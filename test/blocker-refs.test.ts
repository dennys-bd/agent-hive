import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readsRef, REF_GRAMMARS, TASK_ID, type RefGrammar } from '../src/blocker-refs.js';
import { namespaced } from '../src/source.js';
import type { ItemBlockers, Source, SourceConfig } from '../src/types.js';
import { EPICS, FILTER, FIXED, goneItem } from './fakes.js';
import { githubRefs } from '../src/sources/github-refs.js';

test('GitHub\'s grammar reads 12 and #12 as 12, owner/repo#12 as it is, and nothing else: no acme/r12, no task id, no 10-digit number (#810)', () => {
  assert.equal(REF_GRAMMARS.github, githubRefs);
  const cases: [string, string | undefined][] = [
    ['12', '12'], ['#12', '12'], [' #12 ', '12'], ['acme/r#12', 'acme/r#12'], ['acme/r12', undefined], ['ABC-12', undefined], ['1234567890', undefined], ['', undefined],
  ];
  for (const [text, ref] of cases) assert.equal(githubRefs.refOf(text), ref, JSON.stringify(text));
  assert.equal(githubRefs.forms, '12, #12, owner/repo#12');
});

test('GitHub\'s isShort is true only for digits, an issue of the item\'s own repository (#810)', () => {
  assert.deepEqual(['12', 'acme/r#12', 'foo-12', '#12', ''].map((id) => githubRefs.isShort(id)), [true, false, false, false, false]);
});

test('readsRef tries the type\'s grammar, then a task id; with no grammar, a hive task, it reads only a task id (#810)', () => {
  assert.deepEqual(['#12', 'acme/r#12', 'HIVE-3', 'foo-12', 'acme/r12', 'pager'].map((text) => readsRef(githubRefs, text)), ['12', 'acme/r#12', 'HIVE-3', 'foo-12', undefined, undefined]);
  assert.deepEqual(['12', '#12', ' HIVE-3 ', 'foo.bar-7'].map((text) => readsRef(undefined, text)), [undefined, undefined, 'HIVE-3', 'foo.bar-7']);
  assert.equal(TASK_ID.test('3-HIVE'), false);
});

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the sources are two levels up

test('no file under src/ outside src/sources/ imports src/sources/github-blockers.ts (#810)', async () => {
  const files = (await readdir(join(ROOT, 'src'), { recursive: true })).map((p) => p.split(sep).join('/'))
    .filter((p) => /\.tsx?$/.test(p) && !p.startsWith('sources/'));
  const importers: string[] = [];
  for (const p of files) if (/github-blockers(\.js)?['"]/.test(await readFile(join(ROOT, 'src', p), 'utf8'))) importers.push(`src/${p}`);
  assert.deepEqual(importers, []);
});

// A source type whose refs read ABC-12 and none of them short: SourceConfig['type'] holds only github, so the grammar comes by argument (#810)
const ABC: RefGrammar = { refOf: (text) => (/^[A-Z]+-\d+$/.test(text.trim()) ? text.trim() : undefined), isShort: () => false, forms: 'ABC-12' };

function relating(blockers: ItemBlockers, asked: string[]): Source {
  return {
    item: goneItem, resolveFields: async () => {}, settingsOptions: async () => [], setColumn: async () => {}, apply: async () => {},
    listItems: async () => [{ item: { itemId: 'PVTI_1', id: '40', title: 'T', body: '', url: '', blockers }, column: 'Ready' }],
    relate: async (itemId, change) => { asked.push(`${itemId} ${change.ref}`); return { blockers }; },
  };
}

test('namespaced under qualifyId prefixes only what the type calls short: ABC-12 passes both ways even with prefix ABC; GitHub\'s 12 reads foo-12 and acme/r#12 passes (#810)', async () => {
  // Prefix ABC on purpose: under GitHub's grammar ABC-12 would go to the adapter as 12
  const entry = (prefix: string): SourceConfig => ({ name: 'work', qualifyId: true, prefix, type: 'github', owner: 'acme', number: 6, filter: FILTER, taskProps: FIXED, ...EPICS });
  const abc: ItemBlockers = { blockedBy: [{ id: 'ABC-12', title: 'T12', state: 'open' }], blocking: [] };
  const askedAbc: string[] = [];
  const fake = namespaced(entry('ABC'), relating(abc, askedAbc), ABC);
  assert.deepEqual((await fake.listItems())[0].item.blockers, abc, 'out: unchanged');
  const answer = await fake.relate?.('work:PVTI_1', { action: 'add', kind: 'blockedBy', ref: 'ABC-12' });
  assert.deepEqual([askedAbc, answer?.blockers], [['PVTI_1 ABC-12'], abc], 'in: unchanged, and its answer too');

  const gh: ItemBlockers = { blockedBy: [{ id: '12', title: 'T12', state: 'open' }, { id: 'acme/r#12', title: 'R12', state: 'open' }], blocking: [] };
  const shown: ItemBlockers = { blockedBy: [{ ...gh.blockedBy[0], id: 'foo-12' }, gh.blockedBy[1]], blocking: [] };
  const askedGh: string[] = [];
  const github = namespaced(entry('foo'), relating(gh, askedGh)); // the default: REF_GRAMMARS.github
  assert.deepEqual((await github.listItems())[0].item.blockers, shown);
  for (const ref of ['foo-12', 'acme/r#12']) await github.relate?.('work:PVTI_1', { action: 'add', kind: 'blockedBy', ref });
  assert.deepEqual(askedGh, ['PVTI_1 12', 'PVTI_1 acme/r#12']);
});
