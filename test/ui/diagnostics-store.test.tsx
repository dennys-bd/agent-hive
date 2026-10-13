import { afterEach, expect, test, vi } from 'vitest';
import * as store from '@/lib/diagnostics-store';
import type { CheckDiagnostic } from '../../src/types';
import { problemsOf } from './problem-fake';

afterEach(() => { store.resetDiagnostics(); vi.useRealTimers(); });
const LOG = { channel: 'lsp:hive:pyright', run: 'r1' };
const finding = (path: string, line: number, extra: Partial<CheckDiagnostic> = {}): CheckDiagnostic => ({ path, line, column: 1, severity: 'error', message: 'bad', code: 'arg-type', ...extra });

test('a bound file reads its server and state; problems show only while the client is ready, and clear when it leaves ready (#780)', () => {
  store.setClient('k', 'a1', 'pyright', { phase: 'starting' }, LOG);
  store.bindFile('a1', 'src/a.py', 'k', 'python');
  expect(store.activityStatus('a1')).toEqual([{ name: 'pyright', kind: 'server', phase: 'starting', language: 'python', log: LOG }]);
  store.setDiagnostics('k', 'src/a.py', problemsOf('src/a.py', { errors: 1 }, 'pyright'));
  expect(store.fileCounts('a1', 'src/a.py')).toEqual({ errors: 0, warnings: 0, infos: 0 });
  store.setClient('k', 'a1', 'pyright', { phase: 'ready' });
  store.setDiagnostics('k', 'src/a.py', problemsOf('src/a.py', { errors: 1, warnings: 2 }, 'pyright'));
  store.setDiagnostics('k', 'src/b/c.py', problemsOf('src/b/c.py', { warnings: 1, infos: 3 }, 'pyright'));
  expect(store.fileCounts('a1', 'src/a.py')).toEqual({ errors: 1, warnings: 2, infos: 0 });
  expect([...store.activityCounts('a1').keys()]).toEqual(['src/a.py', 'src/b/c.py']);
  expect(store.activityStatus('a1')[0].log).toEqual(LOG);
  store.setClient('k', 'a1', 'pyright', { phase: 'failed', reason: 'exit code 1' });
  expect(store.activityCounts('a1').size).toBe(0);
});

test('every change moves the snapshot; dropClient unbinds its files, unbindFile only its own client (#780, #782)', () => {
  const before = store.snapshot();
  store.setClient('k', 'a1', 'pyright', { phase: 'ready' });
  store.setClient('r', 'a1', 'ruff', { phase: 'ready' }, undefined, 'ruff');
  store.bindFile('a1', 'x.py', 'k', 'python');
  store.bindFile('a1', 'x.py', 'r', 'python');
  expect(store.snapshot()).toBeGreaterThan(before);
  store.unbindFile('a1', 'x.py', 'r');
  expect(store.activityStatus('a1')[0]).toEqual({ name: 'pyright', kind: 'server', phase: 'ready', language: 'python' });
  store.dropClient('k');
  expect(store.activityStatus('a1')).toEqual([{ name: 'ruff', kind: 'server', phase: 'ready' }]);
});

test('a file check replaces that checker\'s problems for its file only, a project check the activity\'s; a finding of a file check about another file is dropped (#782)', () => {
  store.setCheck('a1', 'mypy', { state: 'done', scope: 'file', diagnostics: [finding('a.py', 1), finding('b.py', 1)] }, 'a.py');
  store.setCheck('a1', 'mypy', { state: 'done', scope: 'file', diagnostics: [finding('b.py', 2)] }, 'b.py');
  expect(store.problems('a1').map((g) => [g.path, g.problems.map((x) => x.line)])).toEqual([['a.py', [1]], ['b.py', [2]]]);
  store.setCheck('a1', 'mypy', { state: 'done', scope: 'file', diagnostics: [] }, 'a.py');
  expect(store.problems('a1').map((g) => g.path)).toEqual(['b.py']);
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('x.ts', 1)] }, '');
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('y.ts', 1)] }, '');
  expect(store.problems('a1').map((g) => g.path)).toEqual(['b.py', 'y.ts']);
  expect(store.checkProblems('a1', 'mypy', 'b.py').map((x) => x.source)).toEqual(['mypy']);
  expect([store.hasCheck('a1', 'mypy', 'a.py'), store.hasCheck('a1', 'mypy', 'c.py'), store.hasCheck('a1', 'tsc', '')]).toEqual([true, false, true]);
});

test('a running or failed check keeps its previous problems, stale, and when they came; absent clears them (#782)', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 9, 6, 14, 2).getTime();
  vi.setSystemTime(at);
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('x.ts', 1)] }, '');
  store.checkStarted('a1', 'tsc', '');
  expect(store.problems('a1')[0].problems[0].isStale).toBe(true);
  expect(store.checkStatuses('a1')).toEqual([{ checker: 'tsc', phase: 'running', at }]);
  store.setCheck('a1', 'tsc', { state: 'failed', reason: 'exit code 2', log: { channel: 'check:hive:tsc', run: 'r2' } }, '');
  expect(store.problems('a1')[0].problems[0].isStale).toBe(true);
  expect(store.checkStatuses('a1')).toEqual([{ checker: 'tsc', phase: 'failed', at, reason: 'exit code 2', log: { channel: 'check:hive:tsc', run: 'r2' } }]);
  store.setCheck('a1', 'tsc', { state: 'absent' }, '');
  expect(store.problems('a1')).toEqual([]);
});

test('counts sum both sources with a duplicate once, the server\'s copy kept; the activity\'s checkers list both kinds (#782)', () => {
  store.setClient('k', 'a1', 'typescript-language-server', { phase: 'ready' });
  store.bindFile('a1', 'a.ts', 'k', 'typescript');
  store.setDiagnostics('k', 'a.ts', [{ path: 'a.ts', line: 3, column: 1, severity: 'error', message: "Cannot find name 'x'.", code: '2304', source: 'typescript-language-server', fromServer: true }]);
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('a.ts', 3, { column: 5, code: '2304' }), finding('b.ts', 1, { severity: 'warning' })] }, '');
  expect(store.fileCounts('a1', 'a.ts')).toEqual({ errors: 1, warnings: 0, infos: 0 });
  expect(store.problems('a1')[0].problems.map((x) => x.source)).toEqual(['typescript-language-server']);
  store.setClient('b', 'a1', 'biome', { phase: 'starting' }, undefined, 'biome');
  store.bindFile('a1', 'a.ts', 'b', 'typescript');
  store.bindChecks('a1', 'a.ts', ['tsc', 'mypy']);
  expect(store.activityStatus('a1')).toEqual([{ name: 'typescript-language-server', kind: 'server', phase: 'ready', language: 'typescript' }, { name: 'biome', kind: 'server', phase: 'starting' }, { name: 'tsc', kind: 'checker', phase: 'ready' }, { name: 'mypy', kind: 'checker', phase: 'starting' }]);
  expect(store.answeredSources('a1')).toEqual(['typescript-language-server', 'tsc']);
  store.unbindChecks('a1', 'a.ts');
  expect(store.activityStatus('a1').map((s) => s.name)).toEqual(['typescript-language-server', 'biome', 'tsc']);
});

test('a file checker keeps a phase per file: one file\'s answer or failure leaves another\'s running and results alone; absent and failed do not count as a result (#782)', () => {
  store.setCheck('a1', 'mypy', { state: 'done', scope: 'file', diagnostics: [finding('a.py', 1)] }, 'a.py');
  store.checkStarted('a1', 'mypy', 'b.py');
  store.setCheck('a1', 'mypy', { state: 'done', scope: 'file', diagnostics: [] }, 'c.py');
  expect(store.problems('a1')[0].problems[0].isStale).toBeUndefined();
  expect(store.checkStatuses('a1')[0].phase).toBe('running');
  store.setCheck('a1', 'mypy', { state: 'failed', reason: 'exit code 2' }, 'b.py');
  expect(store.problems('a1')[0].problems[0].isStale).toBeUndefined();
  expect(store.activityStatus('a1')).toEqual([{ name: 'mypy', kind: 'checker', phase: 'failed', reason: 'exit code 2' }]); // b.py's failure is the checker's line
  store.setCheck('a1', 'mypy', { state: 'absent' }, 'd.py');
  expect([store.hasCheck('a1', 'mypy', 'a.py'), store.hasCheck('a1', 'mypy', 'b.py'), store.hasCheck('a1', 'mypy', 'd.py')]).toEqual([true, false, false]);
});

test('a check problem a language server reports at the same path, line and code is not drawn twice as a marker (#782)', () => {
  store.setClient('k', 'a1', 'typescript-language-server', { phase: 'ready' });
  store.setDiagnostics('k', 'a.ts', [{ path: 'a.ts', line: 3, column: 1, severity: 'error', message: 'x', code: '2304', source: 'ts', fromServer: true }]);
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('a.ts', 3, { code: '2304' }), finding('a.ts', 4, { code: '2304' })] }, '');
  expect(store.checkProblems('a1', 'tsc', 'a.ts').map((p) => p.line)).toEqual([4]);
});

const TSC_LOG = { channel: 'check:hive:tsc', run: 'r3' };

test('activityStatus lists the activity\'s language servers, its checker servers, then its command-line checkers, one entry per name; off and an absent checker are left out (#225)', () => {
  store.setClient('ts', 'a1', 'typescript-language-server', { phase: 'absent', reason: 'not installed' });
  store.bindFile('a1', 'a.ts', 'ts', 'typescript');
  store.setClient('ts2', 'a1', 'typescript-language-server', { phase: 'ready' });
  store.setClient('py', 'a1', 'pyright', { phase: 'off' });
  store.setClient('b', 'a1', 'biome', { phase: 'ready' }, undefined, 'biome');
  store.setClient('e', 'a1', 'eslint', { phase: 'absent', reason: 'not installed' }, undefined, 'eslint');
  store.setClient('r', 'a1', 'ruff', { phase: 'off' }, undefined, 'ruff');
  store.setClient('x', 'a2', 'pyright', { phase: 'ready' });
  store.checkStarted('a1', 'mypy', 'a.py');
  store.bindChecks('a1', 'a.ts', ['tsc', 'mypy']);
  expect(store.activityStatus('a1')).toEqual([
    { name: 'typescript-language-server', kind: 'server', phase: 'absent', language: 'typescript', reason: 'not installed' },
    { name: 'biome', kind: 'server', phase: 'ready' },
    { name: 'mypy', kind: 'checker', phase: 'starting' }, // running reads as starting
    { name: 'tsc', kind: 'checker', phase: 'starting' }, // bound to an open file, no answer yet
  ]);
  store.setCheck('a1', 'tsc', { state: 'failed', reason: 'exit code 2', log: TSC_LOG }, '');
  store.setCheck('a1', 'mypy', { state: 'absent' }, 'a.py');
  expect(store.activityStatus('a1').slice(2)).toEqual([{ name: 'tsc', kind: 'checker', phase: 'failed', reason: 'exit code 2', log: TSC_LOG }]);
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [] }, '');
  expect(store.activityStatus('a1').at(-1)).toEqual({ name: 'tsc', kind: 'checker', phase: 'ready' });
  store.setClient('ts', 'a1', 'typescript-language-server', { phase: 'failed', reason: 'spawn node ENOENT' }, LOG);
  expect(store.activityStatus('a1')[0]).toEqual({ name: 'typescript-language-server', kind: 'server', phase: 'failed', language: 'typescript', reason: 'spawn node ENOENT', log: LOG });
  expect(store.activityStatus('a3')).toEqual([]);
});

test('undefined reads every activity: problems, check statuses and answered sources; ownerOf names the first activity with a problem on the path (#225)', () => {
  store.setCheck('a1', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('x.ts', 1)] }, '');
  store.setCheck('a2', 'mypy', { state: 'done', scope: 'file', diagnostics: [finding('a.py', 1)] }, 'a.py');
  store.setCheck('a2', 'tsc', { state: 'done', scope: 'project', diagnostics: [finding('x.ts', 2)] }, '');
  expect(store.problems(undefined).map((g) => [g.path, g.problems.length])).toEqual([['a.py', 1], ['x.ts', 2]]);
  expect(store.problems('a1').map((g) => g.path)).toEqual(['x.ts']);
  expect(store.checkStatuses(undefined).map((s) => s.checker)).toEqual(['tsc', 'mypy', 'tsc']);
  expect(store.answeredSources(undefined)).toEqual(['tsc', 'mypy']);
  expect([store.ownerOf('x.ts'), store.ownerOf('a.py'), store.ownerOf('none.ts')]).toEqual(['a1', 'a2', undefined]);
});

test('fileStatus lists only the clients bound to that file and the command-line checkers bound to it; another file\'s server and checker are left out (#295)', () => {
  store.setClient('ts', 'a1', 'typescript-language-server', { phase: 'ready' });
  store.bindFile('a1', 'a.ts', 'ts', 'typescript');
  store.setClient('py', 'a1', 'pyright', { phase: 'ready' });
  store.bindFile('a1', 'b.py', 'py', 'python');
  store.setClient('b', 'a1', 'biome', { phase: 'ready' }, undefined, 'biome');
  store.bindFile('a1', 'a.ts', 'b', 'typescript');
  store.bindChecks('a1', 'a.ts', ['tsc']);
  store.bindChecks('a1', 'b.py', ['mypy']);
  expect(store.fileStatus('a1', 'a.ts').map((s) => s.name)).toEqual(['typescript-language-server', 'biome', 'tsc']);
  expect(store.fileStatus('a1', 'b.py').map((s) => s.name)).toEqual(['pyright', 'mypy']);
  expect(store.fileStatus('a1', 'c.txt')).toEqual([]);
  expect(store.fileStatus('a2', 'a.ts')).toEqual([]);
});
