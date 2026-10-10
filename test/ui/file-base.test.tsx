import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fileBase from '@/lib/file-base';
import { readView, resetViewState } from '@/lib/view-state';
import { jsonResponse } from '../fakes';

const A = 'a-I1';
const PATH = 'src/a.ts';
let answers: Response[] = [];
const fetchMock = vi.fn(async (_url: string) => answers.shift() ?? jsonResponse({ error: 'no answer' }, 500));
const asked = (): string[] => fetchMock.mock.calls.map(([url]) => url);
const HEAD_ONE = { against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' };

beforeEach(() => {
  resetViewState();
  answers = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fileBase.closeExcept(new Set());
  vi.unstubAllGlobals();
});

test('refresh asks HEAD with the blob id it holds: an answer without text keeps the held text, a refusal changes nothing, one with text replaces it (#668)', async () => {
  answers = [jsonResponse(HEAD_ONE)];
  await fileBase.refresh(A, PATH);
  expect(fileBase.baseOf(A, PATH)).toEqual(HEAD_ONE);
  answers = [jsonResponse({ against: 'head', label: 'HEAD', oid: 'o1' })];
  await fileBase.refresh(A, PATH);
  expect(fileBase.baseOf(A, PATH)).toEqual(HEAD_ONE);
  answers = [jsonResponse({ error: 'a atividade foi apagada' }, 409)];
  await fileBase.refresh(A, PATH);
  expect(fileBase.baseOf(A, PATH)).toEqual(HEAD_ONE);
  answers = [jsonResponse({ against: 'head', label: 'HEAD', oid: 'o2', text: 'two\n' })];
  await fileBase.refresh(A, PATH);
  expect(fileBase.baseOf(A, PATH)).toEqual({ against: 'head', label: 'HEAD', oid: 'o2', text: 'two\n' });
  expect(asked()).toEqual([
    '/activities/a-I1/file-base?path=src%2Fa.ts&against=head',
    '/activities/a-I1/file-base?path=src%2Fa.ts&against=head&oid=o1',
    '/activities/a-I1/file-base?path=src%2Fa.ts&against=head&oid=o1',
    '/activities/a-I1/file-base?path=src%2Fa.ts&against=head&oid=o1',
  ]);
});

test('choose writes the task base to the view state and asks it without HEAD\'s blob id; HEAD again drops the stored pick; subscribers hear it; close forgets the base (#668)', async () => {
  answers = [jsonResponse(HEAD_ONE)];
  await fileBase.refresh(A, PATH);
  const heard = vi.fn();
  const stop = fileBase.subscribe(heard);
  answers = [jsonResponse({ against: 'task', label: 'a1b2c3d (origin/main)', oid: 'o0', text: '' })];
  fileBase.choose(A, PATH, 'task');
  expect([fileBase.chosenBase(A, PATH), readView('changesBase')]).toEqual(['task', { 'a-I1:src/a.ts': 'task' }]);
  await vi.waitFor(() => expect(fileBase.baseOf(A, PATH)?.against).toBe('task'));
  expect(asked().at(-1)).toBe('/activities/a-I1/file-base?path=src%2Fa.ts&against=task');
  fileBase.choose(A, PATH, 'head');
  expect([fileBase.chosenBase(A, PATH), readView('changesBase')]).toEqual(['head', {}]);
  fileBase.close(A, PATH);
  expect(fileBase.baseOf(A, PATH)).toBeUndefined();
  expect(heard).toHaveBeenCalled();
  stop();
});

test('a local activity always reads HEAD; a stored pick that is not task reads as HEAD (#668)', () => {
  resetViewState({ changesBase: { 'local:hive:a.ts': 'task', 'a-I1:src/a.ts': 'task', 'a-I1:b.ts': 'bogus' } });
  expect([fileBase.chosenBase('local:hive', 'a.ts'), fileBase.chosenBase(A, PATH), fileBase.chosenBase(A, 'b.ts')]).toEqual(['head', 'task', 'head']);
});

test('a failed first answer is kept as a failure until an answer lands, and a late answer of a closed file leaves none (#668)', async () => {
  const heard = vi.fn();
  const stop = fileBase.subscribe(heard);
  answers = [jsonResponse({ error: 'a atividade foi apagada' }, 409)];
  await fileBase.refresh(A, PATH);
  expect([fileBase.hasFailed(A, PATH), fileBase.baseOf(A, PATH)]).toEqual([true, undefined]);
  expect(heard).toHaveBeenCalled();
  answers = [jsonResponse(HEAD_ONE)];
  await fileBase.refresh(A, PATH);
  expect([fileBase.hasFailed(A, PATH), fileBase.baseOf(A, PATH)]).toEqual([false, HEAD_ONE]);
  stop();
});

test('one leading BOM of the base text is dropped, as Monaco holds it apart from the buffer (#668)', async () => {
  answers = [jsonResponse({ ...HEAD_ONE, text: '\uFEFFone\n' })];
  await fileBase.refresh(A, PATH);
  expect(fileBase.baseOf(A, PATH)?.text).toBe('one\n');
});

test('moved re-keys the base, a failure and the task pick from the old path to the new, and an answer in flight for the old path is dropped (#818)', async () => {
  answers = [jsonResponse(HEAD_ONE)];
  await fileBase.refresh(A, PATH);
  fileBase.choose(A, PATH, 'task');
  await vi.waitFor(() => expect(asked()).toHaveLength(2)); // the pick's own ask has gone out; its answer is the fetch mock's 500
  await vi.waitFor(() => expect(fileBase.hasFailed(A, PATH)).toBe(true));
  const held = fileBase.baseOf(A, PATH);
  fileBase.moved(A, PATH, 'lib/a.ts');
  expect([fileBase.baseOf(A, PATH), fileBase.hasFailed(A, PATH), fileBase.chosenBase(A, PATH)]).toEqual([undefined, false, 'head']);
  expect([fileBase.baseOf(A, 'lib/a.ts'), fileBase.hasFailed(A, 'lib/a.ts'), fileBase.chosenBase(A, 'lib/a.ts')]).toEqual([held, true, 'task']);
  expect(readView('changesBase')).toEqual({ 'a-I1:lib/a.ts': 'task' });
  let release: (res: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  const pending = fileBase.refresh(A, 'lib/a.ts');
  fileBase.moved(A, 'lib/a.ts', 'docs/a.ts');
  release(jsonResponse({ against: 'task', label: 'late', oid: 'o9', text: 'late\n' }));
  await pending;
  expect([fileBase.baseOf(A, 'lib/a.ts'), fileBase.baseOf(A, 'docs/a.ts')]).toEqual([undefined, held]);
});

test('moved leaves a file with nothing held, and other activities, as they are (#818)', async () => {
  answers = [jsonResponse(HEAD_ONE)];
  await fileBase.refresh(A, PATH);
  fileBase.moved(A, 'other.ts', 'x.ts');
  fileBase.moved('b-I2', PATH, 'x.ts');
  expect([fileBase.baseOf(A, PATH), fileBase.baseOf(A, 'x.ts')]).toEqual([HEAD_ONE, undefined]);
});
