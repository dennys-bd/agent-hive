import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designComment, designLink, issueBody, parseDecomposition } from '../src/decomposition.js';
import {
  NO_BLOCKING_TYPE_MESSAGE, numberOf, keyOfUrl, sourceRefusal, tooDeepMessage, type WriteSource, writeSourceDecomposition,
} from '../src/decomposition-write-source.js';
import { CreateRefusedError } from '../src/source-create.js';
import type { BlockerChange, Decomposition } from '../src/types.js';
import { EXAMPLE } from './fixtures/decomposition.js';

// The write of a decomposition into its goal's own source (#832), over a fake Source: the Jira adapter's own calls are tested in
// test/sources/jira*.test.ts.

const GOAL = { itemId: 'tickets:10001', key: 'ABC-1' };
const ADDRESS = 'https://github.com/acme/docs/blob/main/decomposition.md';
const LABELLED = EXAMPLE.replace('# Site for XPTO\n', '# Site for XPTO\nLabel: decomposed\n');
// One level under the goal, 2 blocked by 1, no design
const FLAT = [
  '# Site', 'A site.', '',
  '## 1 Home page', '### Scope', 'In: the landing page. Out: the form.', '', '### Acceptance criteria', '- the home page renders', '',
  '## 2 Contact page', '### Scope', 'In: the form. Out: other pages.', '', '### Acceptance criteria', '- the form submits', '', 'Blocked by: 1',
].join('\n');

function example(text: string): Decomposition {
  const { decomposition } = parseDecomposition(text);
  assert.ok(decomposition);
  return decomposition;
}

type Fields = Parameters<WriteSource['create']>[0];
interface FakeOptions { depth?: number; depthError?: Error; start?: number; fail?: { at: number; error: Error } }
// Issues numbered from start + 1 (id 10000 + n, key ABC-n), as the adapter answers them namespaced; item answers any issue by its URL
function fakeSource({ depth = 2, depthError, start = 100, fail }: FakeOptions = {}) {
  const calls: string[] = [];
  const made: Fields[] = [];
  const related: [string, BlockerChange][] = [];
  const comments: string[] = [];
  let n = start;
  const source: WriteSource = {
    item: async (itemId) => {
      calls.push(`item ${itemId}`);
      const k = numberOf(itemId) - 10000;
      return { reason: 'listing', entry: { column: 'To Do', item: { itemId, id: `ABC-${k}`, title: '', body: '', url: `https://acme.example/browse/ABC-${k}` } } };
    },
    createDepth: async (itemId) => {
      calls.push(`createDepth ${itemId}`);
      if (depthError !== undefined) throw depthError;
      return depth;
    },
    comment: async (itemId, body) => { calls.push(`comment ${itemId}`); comments.push(body); },
    create: async (fields) => {
      n += 1;
      if (fail?.at === n) throw fail.error;
      calls.push(`create ${fields.title}`);
      made.push(fields);
      return { itemId: `tickets:${10000 + n}`, ref: { id: `ABC-${n}`, url: `https://acme.example/browse/ABC-${n}` } };
    },
    relate: async (itemId, change) => {
      calls.push(`relate ${itemId}`);
      related.push([itemId, change]);
      return { blockers: { blockedBy: [], blocking: [] } };
    },
  };
  return { source, calls, made, related, comments };
}

function recorder() {
  const steps: [string, number][] = [];
  return { steps, record: async (id: string, number: number) => { steps.push([id, number]); } };
}

const TARGET = { goal: GOAL, column: 'To Do', address: ADDRESS };

test('a two-level file under an epic goal creates the first level under the goal and the second under those, in file order, each with its body and the label and no issueType (#832)', async () => {
  const d = example(LABELLED);
  const fake = fakeSource();
  const { steps, record } = recorder();
  assert.deepEqual(await writeSourceDecomposition({ source: fake.source, record }, d, TARGET, {}), { root: 10001 });
  assert.deepEqual(steps, [['design', 10001], ['1', 10101], ['1.1', 10102], ['1.2', 10103], ['2', 10104], ['2.1', 10105], ['2.2', 10106]]);
  assert.deepEqual(fake.made.map((f) => [f.title, f.parent]), [
    ['Backend', 'tickets:10001'], ['Submissions table', 'tickets:10101'], ['Contact API', 'tickets:10101'],
    ['Pages', 'tickets:10001'], ['Contact page', 'tickets:10104'], ['Home page', 'tickets:10104'],
  ]);
  const node = d.nodes[1];
  assert.ok(node);
  assert.deepEqual(fake.made[1], {
    title: 'Submissions table', body: issueBody(node, { parent: 'ABC-101', design: designLink(d, node, ADDRESS) }), column: 'To Do', labels: ['decomposed'], parent: 'tickets:10101',
  });
  assert.equal(fake.made.some((f) => 'issueType' in f), false);
  assert.equal(fake.calls.some((c) => c.startsWith('item ')), false, 'every key is known within one press');
});

test('a one-level file under a standard goal creates each node under the goal, and with no address no Design: line (#832)', async () => {
  const fake = fakeSource({ depth: 1 });
  const { record } = recorder();
  assert.deepEqual(await writeSourceDecomposition({ source: fake.source, record }, example(FLAT), { goal: GOAL, column: 'To Do' }, {}), { root: 10001 });
  assert.deepEqual(fake.made.map((f) => f.parent), ['tickets:10001', 'tickets:10001']);
  assert.ok(fake.made.every((f) => /^Parent: ABC-1$/m.test(f.body ?? '') && !/^Design:/m.test(f.body ?? '')));
});

test('a file too deep, a subtask goal and a goal above the epic are refused 409 before any write, naming the node or the goal (#832)', async () => {
  const deep = fakeSource({ depth: 1 });
  assert.deepEqual(await sourceRefusal(deep.source, example(EXAMPLE), GOAL, true), { status: 409, message: tooDeepMessage('1.1', 'ABC-1', 1) });
  const subtask = fakeSource({ depth: 0 });
  assert.deepEqual(await sourceRefusal(subtask.source, example(FLAT), GOAL, true), { status: 409, message: 'node 1 is too deep for ABC-1: it takes 0 levels of issues under it' });
  const above = fakeSource({ depthError: new CreateRefusedError('ABC-1 is at hierarchy level 2: the Hive creates nothing under it') });
  assert.deepEqual(await sourceRefusal(above.source, example(FLAT), GOAL, true), { status: 409, message: 'ABC-1 is at hierarchy level 2: the Hive creates nothing under it' });
  for (const { calls } of [deep, subtask, above]) assert.deepEqual(calls, ['createDepth tickets:10001']);
  assert.equal(await sourceRefusal(fakeSource().source, example(EXAMPLE), GOAL, true), undefined);
});

test('a file with blockers on a source with no blocking type is refused before any call (#832)', async () => {
  const fake = fakeSource();
  assert.deepEqual(await sourceRefusal(fake.source, example(EXAMPLE), GOAL, false), { status: 409, message: NO_BLOCKING_TYPE_MESSAGE });
  assert.deepEqual(fake.calls, []);
});

test('every Blocked by is one relate add with the blocker\'s key on the blocked issue, in file order; a retry with every issue recorded replays them and creates nothing (#832)', async () => {
  const fake = fakeSource();
  await writeSourceDecomposition({ source: fake.source, record: recorder().record }, example(EXAMPLE), TARGET, {});
  const add = (ref: string): BlockerChange => ({ action: 'add', kind: 'blockedBy', ref });
  assert.deepEqual(fake.related, [['tickets:10103', add('ABC-102')], ['tickets:10104', add('ABC-101')], ['tickets:10105', add('ABC-103')]]);
  const all = { design: 10001, '1': 10101, '1.1': 10102, '1.2': 10103, '2': 10104, '2.1': 10105, '2.2': 10106 };
  const again = fakeSource();
  const { steps, record } = recorder();
  assert.deepEqual(await writeSourceDecomposition({ source: again.source, record }, example(EXAMPLE), TARGET, all), { root: 10001 });
  assert.deepEqual([again.made, steps, again.comments], [[], [], []]);
  assert.deepEqual(again.related, fake.related, 'relate reads before it writes, so a link already there is done');
});

test('the design comment is posted once on the goal and recorded, skipped on a retry, and a file with no design gets none (#832)', async () => {
  const d = example(EXAMPLE);
  const first = fakeSource();
  const { steps, record } = recorder();
  await writeSourceDecomposition({ source: first.source, record }, d, TARGET, {});
  assert.deepEqual([first.calls[0], first.comments, steps[0]], ['comment tickets:10001', [designComment(d)], ['design', 10001]]);
  const retry = fakeSource({ start: 106 });
  await writeSourceDecomposition({ source: retry.source, record: recorder().record }, d, TARGET, { design: 10001 });
  assert.deepEqual(retry.comments, []);
  const flat = fakeSource({ depth: 1 });
  await writeSourceDecomposition({ source: flat.source, record: recorder().record }, example(FLAT), TARGET, {});
  assert.deepEqual(flat.comments, []);
});

test('a failure on the third create answers 502 with what was created, and a retry with the first two recorded creates only the rest; a refusal answers 400 (#832)', async () => {
  const failing = fakeSource({ fail: { at: 103, error: new Error('jira api: HTTP 500') } });
  const first = recorder();
  assert.deepEqual(await writeSourceDecomposition({ source: failing.source, record: first.record }, example(EXAMPLE), TARGET, {}), { error: 'created 2 of 6 issues; jira api: HTTP 500', status: 502 });
  assert.deepEqual(first.steps, [['design', 10001], ['1', 10101], ['1.1', 10102]]);
  const retry = fakeSource({ start: 102 });
  const second = recorder();
  const recorded = { design: 10001, '1': 10101, '1.1': 10102 };
  assert.deepEqual(await writeSourceDecomposition({ source: retry.source, record: second.record }, example(EXAMPLE), TARGET, recorded), { root: 10001 });
  assert.deepEqual(retry.made.map((f) => f.title), ['Contact API', 'Pages', 'Contact page', 'Home page']);
  assert.match(retry.made[0]?.body ?? '', /^Parent: ABC-101$/m, 'the recorded parent\'s key, read from the source');
  assert.deepEqual(retry.calls.filter((c) => c.startsWith('item ')), ['item tickets:10101', 'item tickets:10102']);
  const refused = fakeSource({ fail: { at: 101, error: new CreateRefusedError('the source\'s issueType issue type "Story" is not one of ABC\'s: Epic') } });
  const answer = await writeSourceDecomposition({ source: refused.source, record: recorder().record }, example(EXAMPLE), TARGET, { design: 10001 });
  assert.deepEqual(answer, { error: 'created 0 of 6 issues; the source\'s issueType issue type "Story" is not one of ABC\'s: Epic', status: 400 });
});

test('numberOf reads the adapter\'s numeric id after the source\'s name, and keyOfUrl the key a browse URL ends in (#832)', () => {
  assert.equal(numberOf('tickets:10101'), 10101);
  assert.throws(() => numberOf('tickets:ABC-1'), /no numeric id/);
  assert.deepEqual([keyOfUrl('https://acme.example/browse/ABC-1'), keyOfUrl(''), keyOfUrl('https://acme.example/')], ['ABC-1', undefined, undefined]);
});
