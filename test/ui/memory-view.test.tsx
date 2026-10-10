import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { addLesson, editLesson, readMemory, readStats, removeLesson } from '@/lib/memory-api';
import { charactersText, citedText, kindCounts, lastText, lessonsText, metaText, refusalText, statNumbers } from '@/lib/memory-view';
import type { MemoryEntry } from '../../src/types';
import { jsonResponse } from '../fakes';

const AT = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const lesson = (patch: Partial<MemoryEntry>): MemoryEntry => ({ id: 'm-1', kind: 'fact', text: 'pnpm test is the gate', origin: 'user', at: AT, uses: 0, ...patch });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('a lesson\'s meta line and its citations read in both languages: you or task #812, the stage only from a task, cited 1 time / 5 times (#797)', () => {
  const learned = lesson({ origin: { task: '812', stage: 'build' } });
  for (const [language, you, task, free, once, five] of [
    ['en', 'you · 2026-10-01 · 21 characters', 'task #812 · build · 2026-10-01 · 21 characters', 'task #790 · 2026-10-01 · 21 characters', 'cited 1 time', 'cited 5 times'],
    ['pt', 'você · 2026-10-01 · 21 caracteres', 'tarefa #812 · build · 2026-10-01 · 21 caracteres', 'tarefa #790 · 2026-10-01 · 21 caracteres', 'citada 1 vez', 'citada 5 vezes'],
  ] as const) {
    setLanguage(language);
    expect([metaText(lesson({})), metaText(learned), metaText(lesson({ origin: { task: '790' } }))]).toEqual([you, task, free]);
    expect([citedText(1), citedText(5)]).toEqual([once, five]);
  }
});

test('the usage reads with the language\'s thousands separator, the lessons with their singular and how many came from tasks; kinds are counted (#797)', () => {
  const entries = [lesson({ id: 'm-1' }), lesson({ id: 'm-2', kind: 'pref', origin: { task: '7' } }), lesson({ id: 'm-3', kind: 'pref' })];
  expect([charactersText(87, 4000), lessonsText(entries), lessonsText([entries[0]])]).toEqual(['87 de 4.000 caracteres', '3 lições · 1 vindas de tarefas', '1 lição · 0 vindas de tarefas']);
  expect(kindCounts(entries)).toEqual({ all: 3, pref: 2, fact: 1, avoid: 0 });
  setLanguage('en');
  expect([charactersText(87, 4000), lessonsText(entries)]).toEqual(['87 of 4,000 characters', '3 lessons · 1 from tasks']);
});

test('the telemetry numbers show dashes without runs, the cited lessons out of the total, the tokens with a tilde; the last injection with or without its stage (#797)', () => {
  expect(statNumbers(undefined, 3)).toEqual({ runs: '—', cited: '—', tokens: '—' });
  expect(statNumbers({ runs: 0, cited: 0 }, 3)).toEqual({ runs: '—', cited: '—', tokens: '—' });
  expect(statNumbers({ runs: 1200, cited: 2, tokensPerRun: 150 }, 3)).toEqual({ runs: '1.200', cited: '2 de 3', tokens: '~150' });
  const at = new Date(NOW - 2 * 3_600_000 - 300_000).toISOString();
  expect(lastText({ at, task: '812', stage: 'build', cited: 1 }, NOW)).toBe('última injeção há 2 h, na etapa build de #812 · 1 lição citada');
  expect(lastText({ at: new Date(NOW - 3 * 86_400_000).toISOString(), task: '812', cited: 2 }, NOW)).toBe('última injeção há 3 dias, em #812 · 2 lições citadas');
  setLanguage('en');
  expect(lastText({ at, task: '812', stage: 'build', cited: 1 }, NOW)).toBe('last injected 2 h ago, in the build stage of #812 · 1 lesson cited');
});

test('the five calls reach the workspace\'s memory routes with the UI header on writes; a refusal keeps its code, which reads in the user\'s language (#797)', async () => {
  const view = { entries: [], used: 0, cap: 4000, textMax: 300 };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ error: 'memory is full; go on without saving this lesson', code: 'memory_full' }, 409);
    return jsonResponse(url.endsWith('/stats') ? { runs: 0, cited: 0 } : view);
  });
  vi.stubGlobal('fetch', fetchMock);
  await readMemory('hive');
  await readStats('hive');
  await editLesson('hive', 'm-1', 'avoid', 'x');
  await removeLesson('hive', 'm-1');
  const err = await addLesson('hive', 'fact', 'y').catch((e: unknown) => e);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
    ['/workspaces/hive/memory', 'GET'], ['/workspaces/hive/memory/stats', 'GET'], ['/workspaces/hive/memory/m-1', 'PUT'],
    ['/workspaces/hive/memory/m-1', 'DELETE'], ['/workspaces/hive/memory', 'POST'],
  ]);
  expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('x-hive-ui')).toBe('1');
  expect(refusalText(err)).toBe('a memória está cheia: remova ou encurte uma lição');
  expect(refusalText(new Error('disk full'))).toBe('disk full');
});
