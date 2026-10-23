import { beforeEach, expect, test } from 'vitest';
import { elapsedMs, hoursMinutes, roundRows, segmentsOf } from '@/components/benchmark/execution/execution-rows';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { experiment, run } from '../benchmark/fixtures';
import { bar, HOUR, MINUTE, NOW, SCREEN } from './benchmark-execution-fixtures';

beforeEach(() => setLanguage('pt'));
const LIVE_MS = 3 * HOUR + 12 * MINUTE; // now − 03:58

test("the screen's order: the running round, the ended ones descending, the queued ones ascending, each with its sub line (#465)", () => {
  expect(roundRows(SCREEN, NOW).map((r) => [r.n, r.kind, r.sub])).toEqual([
    [2, 'running', 'começou 03:58'], [1, 'ended', '22:01 → 03:57 · avaliada'], [3, 'queued', 'na fila · começa quando a 2 termina, se antes de 07:00'],
  ]);
});

test("each card: letter, short token, state, delivered of total, tokens, time and action; queued cards from the arm's tasks (#465)", () => {
  const [running, ended, queued] = roundRows(SCREEN, NOW);
  expect(running.cards.map((c) => [c.letter, c.shortToken, c.status, c.delivered, c.total, c.tokens, c.ms, c.action])).toEqual([
    ['A', 'c81e04', 'running', 5, 8, 1_900_000, LIVE_MS, 'open'], ['B', '9f2a6d', 'waiting', 4, 8, 1_400_000, LIVE_MS, 'open'],
    ['C', '41b7e3', 'running', 3, 8, 1_100_000, LIVE_MS, 'open'], ['D', 'b5e912', 'running', 2, 3, 1_100_000, LIVE_MS, 'open'],
  ]);
  expect(running.cards[0].segments).toEqual(bar(5, 2, 1));
  expect(ended.cards.map((c) => [c.status, c.ms, c.action, c.segments])).toEqual([
    ['done', 5 * HOUR + 40 * MINUTE, 'result', bar(8, 0, 0)], ['done', 4 * HOUR + 55 * MINUTE, 'result', bar(8, 0, 0)],
    ['timeout', 6 * HOUR, 'result', bar(6, 0, 2)], ['done', 4 * HOUR + 18 * MINUTE, 'result', bar(3, 0, 0)],
  ]);
  expect(queued.cards.map((c) => [c.letter, c.shortToken, c.status, c.delivered, c.total, c.segments, c.action])).toEqual([
    ['A', '—', 'queued', 0, 8, bar(0, 0, 8), undefined], ['B', '—', 'queued', 0, 8, bar(0, 0, 8), undefined],
    ['C', '—', 'queued', 0, 8, bar(0, 0, 8), undefined], ['D', '—', 'queued', 0, 3, bar(0, 0, 3), undefined],
  ]);
});

test('an ended round not yet evaluated reads avaliando…; a draft shows only its queued rounds, the first just na fila, no until no clause (#465)', () => {
  const evaluating: Experiment = { ...SCREEN, rounds: [{ ...SCREEN.rounds[0], evaluatedAt: undefined }] };
  expect(roundRows(evaluating, NOW)[0].sub).toBe('22:01 → 03:57 · avaliando…');
  const draft: Experiment = { ...SCREEN, status: 'draft', rounds: [], sleeps: [], pace: { ...SCREEN.pace, until: undefined } };
  expect(roundRows(draft, NOW).map((r) => [r.n, r.kind, r.sub])).toEqual([
    [1, 'queued', 'na fila'], [2, 'queued', 'na fila · começa quando a 1 termina'], [3, 'queued', 'na fila · começa quando a 2 termina'],
  ]);
});

test('a run with no progress yet: all open, all green once done; an interrupted run keeps its card, with resultado, beside its rerun (#465)', () => {
  expect(segmentsOf(run('x1x1', { total: 3 }))).toEqual(bar(0, 0, 3));
  expect(segmentsOf(run('x1x1', { total: 2, status: 'done' }))).toEqual(bar(2, 0, 0));
  const rerun = experiment({ status: 'running', rounds: [{ n: 1, startedAt: '2026-10-22T06:00:00', runs: [run('old1', { status: 'interrupted' }), run('new1', { startedAt: '2026-10-22T07:00:00' })] }] });
  expect(roundRows(rerun, NOW)[0].cards.map((c) => [c.token, c.action])).toEqual([['old1', 'result'], ['new1', 'open']]);
});

test("em execução há: now − the first round's start − the slept time, an open sleep counted to now; none before a round (#465)", () => {
  expect(hoursMinutes(elapsedMs(SCREEN, NOW) ?? 0)).toBe('3h12');
  const asleep: Experiment = { ...SCREEN, sleeps: [{ round: 2, at: '2026-10-22T07:00:00', reason: 'quota' }] };
  expect(hoursMinutes(elapsedMs(asleep, NOW) ?? 0)).toBe('8h59');
  expect(elapsedMs(experiment(), NOW)).toBeUndefined();
});
