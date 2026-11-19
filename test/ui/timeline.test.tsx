import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { eventText, groupByDay, matchCheckpoints, shortDate, summaryText, timelineTotals, type StageEvent, type TextPart } from '@/lib/timeline';
import type { StageOutcome } from '../../src/facts';
import type { TimelineEvent } from '../../src/server-timeline';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Local wall-clock times in Sep 2026, so the day rule reads the machine's own calendar
const at = (day: number, hour: number, minute: number, second = 0): string => new Date(2026, 8, day, hour, minute, second).toISOString();
const NOW = new Date(2026, 8, 30, 12, 0).getTime();
const TS = at(30, 10, 0);
const plain = (parts: readonly TextPart[]): string => parts.map((part) => (typeof part === 'string' ? part : part.bold)).join('');
const stage = (over: Partial<StageEvent> = {}): StageEvent =>
  ({ kind: 'stage', ts: TS, stage: 'dev', attempt: 1, outcome: 'done', durationMs: 10 * MIN, waitedMs: 0, ...over });
const words = (events: readonly TimelineEvent[]): string[] => events.map((event) => plain(eventText(event)));

beforeEach(() => setLanguage('pt'));

test('totals sum worked and waited over the stage events only, a negative worked counting 0 (#961)', () => {
  const events: TimelineEvent[] = [
    stage({ durationMs: 24 * MIN, waitedMs: 6 * MIN }), stage({ durationMs: 5 * MIN, waitedMs: 8 * MIN }),
    { kind: 'question', ts: TS, durationMs: 30 * MIN, answered: true }, { kind: 'restart', ts: TS, durationMs: HOUR },
  ];
  expect(timelineTotals(events)).toEqual({ workedMs: 18 * MIN, waitedMs: 14 * MIN });
  expect(timelineTotals([])).toEqual({ workedMs: 0, waitedMs: 0 });
});

test('the summary: desde first with since, the two sums, and nada registrado ainda with neither events nor since (#961)', () => {
  const events = [stage({ durationMs: 24 * MIN, waitedMs: 6 * MIN })];
  expect(summaryText({ events }, 'pt-BR')).toBe('trabalhou 18m · esperou você 6m');
  expect(summaryText({ since: at(29, 8, 0), events }, 'pt-BR')).toBe('desde 29 set · trabalhou 18m · esperou você 6m');
  expect(summaryText({ events: [] }, 'pt-BR')).toBe('nada registrado ainda');
  setLanguage('en');
  expect(summaryText({ since: at(29, 8, 0), events }, 'en-US')).toBe('since Sep 29 · worked 18m · waited for you 6m');
  expect(summaryText({ events: [] }, 'en-US')).toBe('nothing recorded yet');
});

test('days group by the local calendar day of ts, oldest first: hoje, ontem, else the short date in the locale (#961)', () => {
  const events: TimelineEvent[] = [
    { kind: 'pr', ts: at(28, 23, 59), pr: 1 }, { kind: 'pr', ts: at(29, 0, 1), pr: 2 },
    { kind: 'pr', ts: at(29, 18, 0), pr: 3 }, { kind: 'pr', ts: at(30, 9, 0), pr: 4 },
  ];
  expect(groupByDay(events, NOW, 'pt-BR').map((day) => [day.label, day.rows.map((row) => row.index)])).toEqual([['28 set', [0]], ['ontem', [1, 2]], ['hoje', [3]]]);
  expect(shortDate(at(1, 12, 0), 'pt-BR')).toBe('1 set');
  setLanguage('en');
  expect(groupByDay(events, NOW, 'en-US').map((day) => day.label)).toEqual(['Sep 28', 'yesterday', 'today']);
});

test('a stage row takes the nearest free checkpoint of its stage captured in [ts − duration, ts + 5 s]; never another stage\'s, one outside, or one taken (#961)', () => {
  const cp = (n: number, stageName: string, iso: string) => ({ n, stage: stageName, at: iso });
  const events: TimelineEvent[] = [
    stage({ ts: at(30, 10, 0), durationMs: 10 * MIN }), // run 9:50:00–10:00:00
    { kind: 'pr', ts: at(30, 10, 1), pr: 7 },
    stage({ ts: at(30, 10, 0, 3), durationMs: 10 * MIN }), // another dev run, ending 3 s later
    stage({ ts: at(30, 11, 0), stage: 'spec', durationMs: 5 * MIN }),
  ];
  const checkpoints = [
    cp(1, 'dev', at(30, 10, 0, 4)), // 4 s after row 0: inside both dev windows, row 0 takes it
    cp(2, 'dev', at(30, 9, 40)), // before either run started
    cp(3, 'spec', at(30, 10, 0, 1)), // another stage for the dev rows, outside spec's own window
    cp(4, 'dev', at(30, 10, 0, 6)), // 6 s after row 0 (out), 3 s after row 2 (in)
    cp(5, 'dev', at(30, 9, 55)), // inside both windows, but never the nearest
  ];
  expect([...matchCheckpoints(events, checkpoints)]).toEqual([[0, 1], [2, 4]]);
});

test('each move by, stage outcome, approval result and question state has its own words, in Portuguese and in English (#961)', () => {
  const moves = (['hand', 'auto', 'on_finish', 'source', 'merge', 'approval', 'epic'] as const).map((by): TimelineEvent => ({ kind: 'move', ts: TS, to: 'dev', by }));
  const outcomes = (['done', 'approval', 'stop', 'agent_stop', 'killed', 'failed', 'exit'] as const).map((outcome) => stage({ outcome, durationMs: 22 * MIN }));
  const approvals: TimelineEvent[] = [
    { kind: 'approval', ts: TS, result: 'granted', durationMs: 16 * MIN },
    { kind: 'approval', ts: TS, result: 'rejected', durationMs: 16 * MIN, start: false },
    { kind: 'approval', ts: TS, result: 'rejected', durationMs: 16 * MIN, start: true },
    { kind: 'approval', ts: TS, result: 'expired', durationMs: 16 * MIN },
  ];
  const others: TimelineEvent[] = [
    { kind: 'question', ts: TS, durationMs: 6 * MIN, answered: true }, { kind: 'question', ts: TS, durationMs: 0, answered: false },
    { kind: 'restart', ts: TS, stage: 'dev', durationMs: 29 * HOUR }, { kind: 'pr', ts: TS, pr: 515 },
    { kind: 'move', ts: TS, to: 'dev' }, stage({ stage: undefined, outcome: undefined, durationMs: 22 * MIN }),
    stage({ outcome: 'paused' as StageOutcome, durationMs: 22 * MIN }), // a value this build does not know shows as it is
  ];
  expect(words(moves)).toEqual([
    'foi para dev · por você', 'foi para dev · automático', 'foi para dev · automático', 'foi para dev · pela source',
    'foi para dev · pelo merge', 'foi para dev · pela aprovação', 'foi para dev · pelo épico',
  ]);
  expect(words(outcomes)).toEqual([
    'dev terminou · 22m', 'dev terminou em aprovação · 22m', 'dev você parou · 22m', 'dev parou sozinha · 22m',
    'dev encerrada · 22m', 'dev falhou · 22m', 'dev o processo saiu · 22m',
  ]);
  expect(words(approvals)).toEqual([
    'você aprovou · depois de 16m', 'você pediu mudanças · depois de 16m', 'você pediu mudanças · depois de 16m · começou agora', 'a aprovação expirou · depois de 16m',
  ]);
  expect(words(others)).toEqual([
    'pergunta · você respondeu em 6m', 'pergunta · ficou sem resposta', 'dev reiniciada · estava parada há 1d5h', 'abriu o PR #515', 'foi para dev', '22m', 'dev paused · 22m',
  ]);
  expect(plain(eventText(stage({ durationMs: 24 * MIN }), 1))).toBe('dev terminou · 24m · ponto 1');
  expect(eventText({ kind: 'pr', ts: TS, pr: 515 })).toEqual(['abriu o PR', ' ', { bold: '#515' }]);
  expect(eventText({ kind: 'move', ts: TS, to: 'dev', by: 'hand' })).toEqual(['foi para', ' ', { bold: 'dev' }, ' · ', 'por você']);
  setLanguage('en');
  expect(words(moves)).toEqual([
    'moved to dev · by you', 'moved to dev · automatic', 'moved to dev · automatic', 'moved to dev · by the source',
    'moved to dev · by the merge', 'moved to dev · by the approval', 'moved to dev · by the epic',
  ]);
  expect(words(outcomes)).toEqual([
    'dev finished · 22m', 'dev finished in approval · 22m', 'dev you stopped · 22m', 'dev stopped on its own · 22m',
    'dev ended · 22m', 'dev failed · 22m', 'dev the process exited · 22m',
  ]);
  expect(words(approvals)).toEqual([
    'you approved · after 16m', 'you asked for changes · after 16m', 'you asked for changes · after 16m · started right away', 'the approval expired · after 16m',
  ]);
  expect(words(others)).toEqual([
    'question · you answered in 6m', 'question · went unanswered', 'dev restarted · had been stopped for 1d5h', 'opened PR #515', 'moved to dev', '22m', 'dev paused · 22m',
  ]);
  expect(plain(eventText(stage({ durationMs: 24 * MIN }), 1))).toBe('dev finished · 24m · checkpoint 1');
});
