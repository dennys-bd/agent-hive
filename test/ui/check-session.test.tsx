import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachChecks, notifyChecksSaved, resetChecks } from '@/lib/check-session';
import * as store from '@/lib/diagnostics-store';
import { EDITOR_DEFAULTS } from '../../src/types';
import { jsonResponse } from '../fakes';
import { FakeModel, markers, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
let answers: Record<string, unknown> = {};
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => jsonResponse(answers[url.split('/check/')[1]] ?? { state: 'absent' }));
const posted = (): string[] => fetchMock.mock.calls.map(([url, init]) => `${url} ${String(init?.body)}`);
const input = (path: string, model: FakeModel) => ({ activityId: 'a1', workspace: 'hive', path, model: model as never, editor: EDITOR_DEFAULTS });
const DONE = (path: string) => ({ state: 'done', scope: 'file', diagnostics: [{ path, line: 2, column: 3, severity: 'error', message: 'bad', code: 'arg-type' }], log: { channel: 'check:hive:mypy', run: 'r1' } });
const phases = (): [string, string][] => store.checkStatuses('a1').map((s) => [s.checker, s.phase]);

beforeEach(() => { answers = {}; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { resetChecks(); resetMonacoFakes(); vi.unstubAllGlobals(); });

test('opening a Python file runs mypy and pylint, on by default; mypy\'s answer becomes the model\'s markers and the store\'s problems (#782)', async () => {
  answers = { mypy: DONE('a.py') };
  const model = new FakeModel('x', 'python');
  attachChecks(input('a.py', model));
  expect(posted()).toEqual(['/activities/a1/check/mypy {"path":"a.py"}', '/activities/a1/check/pylint {"path":"a.py"}']);
  await vi.waitFor(() => expect(store.fileSources('a1', 'a.py')).toEqual([{ name: 'mypy', phase: 'ready' }, { name: 'pylint', phase: 'absent' }]));
  await vi.waitFor(() => expect(markers.find((m) => m.owner === 'check:mypy')).toMatchObject({ model, list: [{ startLineNumber: 2, startColumn: 3, message: 'bad', severity: 8, source: 'mypy', code: 'arg-type' }] }));
  expect(store.fileCounts('a1', 'a.py')).toEqual({ errors: 1, warnings: 0, infos: 0 });
});

test('a file opened again runs only the checkers with no result for its target: a file checker per file, a project checker once (#782)', async () => {
  answers = { tsc: { state: 'done', scope: 'project', diagnostics: [], log: { channel: 'check:hive:tsc', run: 'r1' } }, mypy: DONE('a.py') };
  attachChecks(input('src/a.ts', new FakeModel('a', 'typescript')));
  attachChecks(input('src/b.ts', new FakeModel('b', 'typescript')));
  attachChecks(input('a.py', new FakeModel('x', 'python')));
  attachChecks(input('a.py', new FakeModel('x', 'python')));
  attachChecks(input('b.py', new FakeModel('y', 'python')));
  expect(posted().map((p) => p.split(' ')[0].split('/check/')[1])).toEqual(['tsc', 'mypy', 'pylint', 'mypy', 'pylint']);
  await settle();
});

test('a save runs every checker of the file again; a superseded answer is ignored and leaves it running (#782)', async () => {
  answers = { mypy: DONE('a.py') };
  attachChecks(input('a.py', new FakeModel('x', 'python')));
  await vi.waitFor(() => expect(phases()).toEqual([['mypy', 'done'], ['pylint', 'absent']]));
  answers = { mypy: { state: 'superseded' }, pylint: { state: 'superseded' } };
  notifyChecksSaved('a1', 'a.py');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  await settle();
  await settle();
  expect(phases()).toEqual([['mypy', 'running'], ['pylint', 'running']]);
  expect(store.problems('a1')[0].problems[0].isStale).toBe(true);
});

test('an answer that does not read fails the checker; detaching clears the file\'s check markers (#782)', async () => {
  answers = { mypy: { path: 'a.py', text: 'x' } };
  const model = new FakeModel('x', 'python');
  const stop = attachChecks(input('a.py', model));
  await vi.waitFor(() => expect(phases()).toEqual([['mypy', 'failed'], ['pylint', 'absent']]));
  expect(store.checkStatuses('a1')[0].reason).toBe('an answer that does not read');
  stop();
  await settle();
  expect(markers.slice(-2).map((m) => [m.owner, m.list])).toEqual([['check:mypy', []], ['check:pylint', []]]);
  expect(store.fileSources('a1', 'a.py')).toEqual([]);
});
