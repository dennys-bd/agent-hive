import { beforeEach, expect, test } from 'vitest';
import {
  collectorText, durationFields, durationMs, durationText, envText, judgeableRuns, mapRow, nextScenarioId, parseEnv, resolve, riskyArms, rowDraft, rowFrom,
  rowText, scenarioIdsValid, scenariosText, toggleScope, tokenText,
} from '@/components/benchmark/config/config-lib';
import { setLanguage } from '@/i18n';
import { arm, experiment, run } from '../benchmark/fixtures';

beforeEach(() => setLanguage('pt'));
const ARMS = ['A', 'B', 'C', 'D'].map((letter, i) => arm(`a${i + 1}`, letter));
const scenario = (id: string) => ({ id, title: '', text: '' });

test('a duration reads 20h, 1h30, 45min or 1h; its two fields go back to ms: both empty is none, a bad or a zero one is NaN (#463)', () => {
  expect([72_000_000, 5_400_000, 2_700_000, 3_600_000].map(durationText)).toEqual(['20h', '1h30', '45min', '1h']);
  expect([durationFields(5_400_000), durationFields(undefined)]).toEqual([{ hours: '1', minutes: '30' }, { hours: '', minutes: '' }]);
  expect([durationMs({ hours: '1', minutes: '30' }), durationMs({ hours: '', minutes: '45' }), durationMs({ hours: ' ', minutes: '' })]).toEqual([5_400_000, 2_700_000, undefined]);
  expect([durationMs({ hours: 'x', minutes: '' }), durationMs({ hours: '0', minutes: '0' }), durationMs({ hours: '1.5', minutes: '' })]).toEqual([NaN, NaN, NaN]);
});

test('token counts read 4M, 1.5M, 12k, 900 and 0 (#463)', () => {
  expect([4_000_000, 1_500_000, 12_000, 900, 0].map(tokenText)).toEqual(['4M', '1.5M', '12k', '900', '0']);
});

test("resolve reads an arm's own value, else the row's; the risky arms run bypassPermissions with an empty deny list (#463)", () => {
  const permissionMode = { all: 'dontAsk', perArm: { a1: 'dontAsk', a2: 'dontAsk', a3: 'bypassPermissions', a4: 'dontAsk' } };
  expect([resolve(permissionMode, 'a3'), resolve({ all: ['x'] }, 'a3')]).toEqual(['bypassPermissions', ['x']]);
  expect(riskyArms(ARMS, { permissionMode, deniedTools: { all: [] } }).map((a) => a.letter)).toEqual(['C']);
  expect(riskyArms(ARMS, { permissionMode, deniedTools: { all: [], perArm: { a1: [], a2: [], a3: ['WebFetch'], a4: [] } } })).toEqual([]);
  expect(riskyArms(ARMS, { permissionMode: { all: 'bypassPermissions' }, deniedTools: { all: ['WebFetch'] } })).toEqual([]);
});

test("toggleScope gives every arm the row's value, and back drops perArm keeping all; mapRow maps both; nothing is mutated (#463)", () => {
  const row = { all: ['github.com'] };
  const varied = toggleScope(row, ['a1', 'a2']);
  expect(varied).toEqual({ all: ['github.com'], perArm: { a1: ['github.com'], a2: ['github.com'] } });
  expect(toggleScope({ ...varied, perArm: { a1: ['x'], a2: [] } }, ['a1', 'a2'])).toEqual({ all: ['github.com'] });
  expect(row).toEqual({ all: ['github.com'] });
  expect(mapRow({ all: 1, perArm: { a1: 2 } }, (n) => n * 10)).toEqual({ all: 10, perArm: { a1: 20 } });
});

test('the env text: one NAME=value per line, blanks dropped, a value may hold =; a line without a valid name is bad (#463)', () => {
  expect(parseEnv('CI=1\n\n HIVE_BENCH=a=b \n1BAD=x\nnoequals')).toEqual({ env: { CI: '1', HIVE_BENCH: 'a=b' }, bad: ['1BAD=x', 'noequals'] });
  expect(envText({ CI: '1', HIVE_BENCH: '1' })).toBe('CI=1\nHIVE_BENCH=1');
});

test('scenarios read N cenários S1–S6, one alone, none as nenhum cenário; the next id is the first free S<n>; ids must be filled and unique (#463)', () => {
  expect([scenariosText([scenario('S1'), scenario('S2'), scenario('S6')]), scenariosText([scenario('S1')]), scenariosText([])]).toEqual(['3 cenários S1–S6', '1 cenário S1', 'nenhum cenário']);
  expect([nextScenarioId([scenario('S1'), scenario('S3')]), nextScenarioId([])]).toEqual(['S2', 'S1']);
  expect([scenarioIdsValid([scenario('S1'), scenario('S2')]), scenarioIdsValid([scenario('S1'), scenario(' S1 ')]), scenarioIdsValid([scenario(' ')])]).toEqual([true, false, false]);
});

test('a collector reads its specialized agent, else agent · model; the rows round-trip, an empty model or focus left out; the judgeable runs are the route’s (#463)', () => {
  expect([collectorText({ agent: 'claude', specializedAgent: 'code-reviewer' }), collectorText({ agent: 'claude', model: 'sonnet' }), rowText({ agent: 'codex' })]).toEqual(['code-reviewer', 'claude · sonnet', 'codex']);
  const row = { agent: 'claude' as const, model: 'sonnet', focus: 'tdd' };
  expect(rowFrom(rowDraft(row))).toEqual(row);
  expect(rowFrom({ ...rowDraft(row), model: ' ', focus: '' })).toEqual({ agent: 'claude' });
  const runs = [run('t1', { status: 'done' }), run('t2', { status: 'interrupted' }), run('t3', { status: 'timeout' }), run('t4')];
  expect(judgeableRuns(experiment({ rounds: [{ n: 1, runs }] }))).toBe(2);
});
