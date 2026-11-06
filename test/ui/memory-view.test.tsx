import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { addLesson, discardChange, editLesson, readMemory, readStats, removeLesson, restoreChange } from '@/lib/memory-api';
import { canSaveLesson, changeByText, changeRefusalText, charactersText, historyCountText, readText, kindCounts, lastText, lessonsText, metaText, originDateText, refusalText, statNumbers, usedText } from '@/lib/memory-view';
import type { MemoryChange, MemoryEntry } from '../../src/types';
import { jsonResponse } from '../fakes';

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const BODY = 'it runs lint, tsc and both runners';
const lesson = (patch: Partial<MemoryEntry>): MemoryEntry => ({ id: 'm-1', kind: 'fact', description: 'pnpm test is the gate', body: BODY, origin: 'user', at: AT, uses: 0, ...patch });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('a lesson\'s meta line and its reads read in both languages: you or task #812, the stage only from a task, read 1 time / 5 times (#797, #681)', () => {
  const learned = lesson({ origin: { task: '812', stage: 'build' } });
  for (const [language, you, task, free, once, five] of [
    ['en', `you · 2026-10-01 · description 21 · body ${BODY.length} characters`, `task #812 · build · 2026-10-01 · description 21 · body ${BODY.length} characters`, `task #790 · 2026-10-01 · description 21 · body ${BODY.length} characters`, 'read 1 time', 'read 5 times'],
    ['pt', `você · 2026-10-01 · descrição 21 · corpo ${BODY.length} caracteres`, `tarefa #812 · build · 2026-10-01 · descrição 21 · corpo ${BODY.length} caracteres`, `tarefa #790 · 2026-10-01 · descrição 21 · corpo ${BODY.length} caracteres`, 'lida 1 vez', 'lida 5 vezes'],
  ] as const) {
    setLanguage(language);
    expect([metaText(lesson({})), metaText(learned), metaText(lesson({ origin: { task: '790' } }))]).toEqual([you, task, free]);
    expect([readText(1), readText(5)]).toEqual([once, five]);
  }
});

test('the usage reads with the language\'s thousands separator, the lessons with their singular and how many came from tasks; kinds are counted (#797)', () => {
  const entries = [lesson({ id: 'm-1' }), lesson({ id: 'm-2', kind: 'pref', origin: { task: '7' } }), lesson({ id: 'm-3', kind: 'pref' })];
  expect(usedText(87, 4000)).toBe('87 de 4.000 caracteres em descrições');
  expect([charactersText(87, 4000), lessonsText(entries), lessonsText([entries[0]])]).toEqual(['87 de 4.000 caracteres', '3 lições · 1 vindas de tarefas', '1 lição · 0 vindas de tarefas']);
  expect(kindCounts(entries)).toEqual({ all: 3, pref: 2, fact: 1, avoid: 0 });
  setLanguage('en');
  expect(usedText(87, 4000)).toBe('87 of 4,000 characters in descriptions');
  expect([charactersText(87, 4000), lessonsText(entries)]).toEqual(['87 of 4,000 characters', '3 lessons · 1 from tasks']);
});

test('the telemetry numbers show dashes without runs, the lessons read out of the total, the tokens with a tilde; the last run with or without its stage (#797, #681)', () => {
  expect(statNumbers(undefined, 3)).toEqual({ runs: '—', read: '—', tokens: '—' });
  expect(statNumbers({ runs: 0, read: 0 }, 3)).toEqual({ runs: '—', read: '—', tokens: '—' });
  expect(statNumbers({ runs: 1200, read: 2, tokensPerRun: 150 }, 3)).toEqual({ runs: '1.200', read: '2 de 3', tokens: '~150' });
  const at = new Date(NOW - 2 * 3_600_000 - 300_000).toISOString();
  expect(lastText({ at, task: '812', stage: 'build', read: 1 }, NOW)).toBe('última execução há 2 h, na etapa build de #812 · 1 lição lida');
  expect(lastText({ at: new Date(NOW - 3 * 86_400_000).toISOString(), task: '812', read: 2 }, NOW)).toBe('última execução há 3 dias, em #812 · 2 lições lidas');
  setLanguage('en');
  expect(lastText({ at, task: '812', stage: 'build', read: 1 }, NOW)).toBe('last run 2 h ago, in the build stage of #812 · 1 lesson read');
  expect(lastText({ at, task: '812', read: 2 }, NOW)).toBe('last run 2 h ago, in #812 · 2 lessons read');
  expect(statNumbers({ runs: 3, read: 1 }, 3).read).toBe('1 of 3');
});

test('the seven calls reach the workspace\'s memory routes with the UI header on writes; a refusal keeps its code, which reads in the user\'s language (#797)', async () => {
  const view = { entries: [], history: [], used: 0, cap: 4000, descriptionMax: 150, bodyMax: 4000 };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/restore')) return jsonResponse(view);
    if (init?.method === 'POST') return jsonResponse({ error: 'memory is full; go on without saving this lesson', code: 'memory_full' }, 409);
    return jsonResponse(url.endsWith('/stats') ? { runs: 0, read: 0 } : view);
  });
  vi.stubGlobal('fetch', fetchMock);
  await readMemory('hive');
  await readStats('hive');
  await editLesson('hive', 'm-1', { kind: 'avoid', description: 'x', body: 'y' });
  await removeLesson('hive', 'm-1');
  await restoreChange('hive', 'h-3');
  await discardChange('hive', 'h-3');
  const err = await addLesson('hive', { kind: 'fact', description: 'y', body: 'z' }).catch((e: unknown) => e);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
    ['/workspaces/hive/memory', 'GET'], ['/workspaces/hive/memory/stats', 'GET'], ['/workspaces/hive/memory/m-1', 'PUT'],
    ['/workspaces/hive/memory/m-1', 'DELETE'], ['/workspaces/hive/memory/history/h-3/restore', 'POST'], ['/workspaces/hive/memory/history/h-3', 'DELETE'],
    ['/workspaces/hive/memory', 'POST'],
  ]);
  expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('x-hive-ui')).toBe('1');
  expect(fetchMock.mock.calls[2][1]?.body).toBe(JSON.stringify({ kind: 'avoid', description: 'x', body: 'y' }));
  expect(refusalText(err)).toBe('a memória está cheia: remova uma lição ou encurte uma descrição');
  expect(refusalText(new Error('disk full'))).toBe('disk full');
  const historyless = { entries: [], used: 0, cap: 4000, descriptionMax: 150, bodyMax: 4000 };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(historyless)));
  await expect(readMemory('hive')).rejects.toThrow('unexpected answer'); // #684: a view with no history is another daemon's answer
});

test('a change reads who made it, its date and the kind the lesson had; the history counts its changes against the bound; a change no longer there reads its own refusal, in both languages (#684)', () => {
  const change: MemoryChange = { id: 'h-1', entry: lesson({ kind: 'avoid' }), action: 'removed', by: { task: '741', stage: 'build' }, why: 'w', at: '2026-11-05T10:00:00.000Z' };
  const gone = Object.assign(new Error("no change h-9 in this workspace's memory"), { status: 404, code: 'unknown_memory' });
  const full = Object.assign(new Error('memory is full; go on without saving this lesson'), { status: 409, code: 'memory_full' });
  expect([changeByText(change), changeByText({ ...change, by: 'local' }), changeByText({ ...change, by: { task: '790' } })])
    .toEqual(['por tarefa #741 · build · 2026-11-05 · era evitar', 'por sessão local · 2026-11-05 · era evitar', 'por tarefa #790 · 2026-11-05 · era evitar']);
  expect([historyCountText(0), historyCountText(1), historyCountText(3)])
    .toEqual(['0 mudanças · guarda as 50 mais recentes', '1 mudança · guarda as 50 mais recentes', '3 mudanças · guarda as 50 mais recentes']);
  expect([changeRefusalText(gone), changeRefusalText(full), changeRefusalText(new Error('disk full'))])
    .toEqual(['esta mudança não está mais no histórico', 'a memória está cheia: remova uma lição ou encurte uma descrição', 'disk full']);
  setLanguage('en');
  expect([changeByText(change), historyCountText(1), historyCountText(2), changeRefusalText(gone)])
    .toEqual(['by task #741 · build · 2026-11-05 · was avoid', '1 change · keeps the newest 50', '2 changes · keeps the newest 50', 'this change is no longer in the history']);
});

test('a lesson saved from a local session reads local session / sessão local where a task\'s reads its id, and counts among those not the user\'s (#256)', () => {
  const local = lesson({ origin: 'local' });
  for (const [language, meta, count] of [
    ['en', `local session · 2026-10-01 · description 21 · body ${BODY.length} characters`, '2 lessons · 1 from tasks'],
    ['pt', `sessão local · 2026-10-01 · descrição 21 · corpo ${BODY.length} caracteres`, '2 lições · 1 vindas de tarefas'],
  ] as const) {
    setLanguage(language);
    expect(metaText(local)).toBe(meta);
    expect(lessonsText([local, lesson({ id: 'm-2' })])).toBe(count);
  }
});

test('originDateText is the meta line without the sizes; canSaveLesson needs both fields, each within its limit (#680)', () => {
  expect(originDateText(lesson({ origin: { task: '812', stage: 'build' } }))).toBe('tarefa #812 · build · 2026-10-01');
  expect([canSaveLesson('d', 'b'), canSaveLesson(' ', 'b'), canSaveLesson('d', '\n'), canSaveLesson('d'.repeat(151), 'b'), canSaveLesson('d', 'b'.repeat(4001)), canSaveLesson('d'.repeat(150), 'b'.repeat(4000)), canSaveLesson(` ${'d'.repeat(150)} `, 'b')])
    .toEqual([true, false, false, false, false, true, true]);
});
