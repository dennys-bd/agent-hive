import { beforeEach, expect, test } from 'vitest';
import { DOT_CLASS, groupExperiments, subLine } from '@/components/benchmark/sidebar-groups';
import { setLanguage } from '@/i18n';
import { ARCHIVED, ARCHIVED_DRAFT, DONE, DONE_OLD, DRAFT, EXPERIMENTS, MCP_DRAFT, RUNNING } from './benchmark-fixtures';
import { experiment } from '../benchmark/fixtures';

beforeEach(() => setLanguage('pt'));
const ids = (query = '') => groupExperiments(EXPERIMENTS, query).groups.map((g) => [g.id, g.experiments.map((e) => e.id)]);

test('executando, rascunhos, concluídos in that order, newest first; sleeping is running; archived kept apart and counted; an empty group is left out (#461)', () => {
  expect(ids()).toEqual([['running', [RUNNING.id]], ['draft', [DRAFT.id, MCP_DRAFT.id]], ['done', [DONE.id, DONE_OLD.id]]]);
  const sleeping = experiment({ id: 'zz', status: 'sleeping', createdAt: '2026-10-23T09:00:00' });
  expect(groupExperiments([sleeping, DONE], '').groups.map((g) => g.id)).toEqual(['running', 'done']);
  const { archived, archivedCount } = groupExperiments(EXPERIMENTS, '');
  expect([archived.map((e) => e.id), archivedCount]).toEqual([[ARCHIVED_DRAFT.id, ARCHIVED.id], 2]);
});

test('the search: a case-insensitive substring of the name, across every group and the archived ones; a group left empty hides; the count stays (#461)', () => {
  expect(ids('OPUS')).toEqual([['draft', [DRAFT.id]]]);
  expect(groupExperiments(EXPERIMENTS, 'opus').archived.map((e) => e.id)).toEqual([ARCHIVED.id]);
  expect(groupExperiments(EXPERIMENTS, 'nothing')).toEqual({ groups: [], archived: [], archivedCount: 2 });
});

test('the four sub lines, as the screen writes them, in both languages (#461)', () => {
  expect([RUNNING, DRAFT, MCP_DRAFT, DONE, DONE_OLD].map(subLine)).toEqual([
    'rodada 2/3 · via mcp', 'criado 10:12', 'via mcp · 09:40', '30 set · 3 rodadas', '27 set · 2 rodadas',
  ]);
  expect(subLine(experiment({ status: 'done', createdAt: '2026-09-05T09:00:00', rounds: [{ n: 1, startedAt: '2026-09-05T10:00:00', runs: [] }] }))).toBe('5 set · 1 rodada');
  expect(subLine(experiment({ status: 'running', createdAt: '2026-09-05T09:00:00' }))).toBe('rodada 0/3');
  setLanguage('en');
  expect([RUNNING, DRAFT, DONE].map(subLine)).toEqual(['round 2/3 · via mcp', 'created 10:12', '30 Sep · 3 rounds']);
});

test("each status's dot is the screen's: ok running and sleeping, queued the drafts, done the finished (#461)", () => {
  expect(DOT_CLASS).toEqual({ running: 'text-working', sleeping: 'text-working', draft: 'text-empty', done: 'text-muted-foreground' });
});
