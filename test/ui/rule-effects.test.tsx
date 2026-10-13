import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { effectsInForce, ruleEffectText, rulesBlocks, rulesLabel, ruleState, ruleStateText } from '@/lib/rule-effects';
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { DAY_STAGE, FIRED, NONE, SESSION_FORCE, STATE, WEEK_CAP } from './rules-fixtures';

beforeEach(() => setLanguage('pt'));

test('effectsInForce: the total cap, each stage with fired stage rules in key order, then the signal as its raw state; a Stage.maxWorkers-only cap is not a rule effect', () => {
  expect(effectsInForce(NONE)).toEqual([]);
  expect(effectsInForce(FIRED)).toEqual(['máx 2 workers', 'review 1', 'sinal yellow']);
  expect(effectsInForce({ ...NONE, stageCaps: { build: 3 } }), 'no stageCapRules key: Stage.maxWorkers alone').toEqual([]);
  const dev: UsageRule = { ...DAY_STAGE, stage: 'dev', maxWorkers: 0 };
  expect(effectsInForce({ ...NONE, stageCaps: { dev: 0, review: 1, build: 3 }, stageCapRules: { dev: [dev], review: [DAY_STAGE] } })).toEqual(['dev 0', 'review 1']);
});

test('rulesLabel: nenhuma ativa with no title; full joins with ·; short is the first and +n; short with one effect reads as full', () => {
  expect(rulesLabel([], 'full')).toEqual({ text: 'nenhuma ativa' });
  expect(rulesLabel([], 'short')).toEqual({ text: 'nenhuma ativa' });
  const effects = ['máx 2 workers', 'review 1', 'sinal yellow'];
  const title = 'valendo: máx 2 workers · review 1 · sinal yellow';
  expect(rulesLabel(effects, 'full')).toEqual({ text: 'máx 2 workers · review 1 · sinal yellow', title });
  expect(rulesLabel(effects, 'short')).toEqual({ text: 'máx 2 workers +2', title });
  expect(rulesLabel(['sinal red'], 'short')).toEqual({ text: 'sinal red', title: 'valendo: sinal red' });
});

test('ruleState: paused wins over fired; binding on any effect list, a tie and a signal-only bind included; weaker at or above its percent; left counts down; unread with no reading', () => {
  const pause = { rule: WEEK_CAP, until: 'manual', estimate: false } as const;
  expect(ruleState(WEEK_CAP, { ...FIRED, disabledRules: [pause] }, 95)).toEqual({ kind: 'paused', pause });
  expect(ruleState(WEEK_CAP, FIRED, 91)).toEqual({ kind: 'binding' });
  expect(ruleState(SESSION_FORCE, FIRED, undefined), 'binds the signal, read or not').toEqual({ kind: 'binding' });
  expect(ruleState(DAY_STAGE, FIRED, undefined)).toEqual({ kind: 'binding' });
  const tie: UsageRule = { source: 'month', percent: 50, maxWorkers: 2 };
  expect(ruleState(tie, { ...FIRED, capRules: [WEEK_CAP, tie] }, 60)).toEqual({ kind: 'binding' });
  const both: UsageRule = { source: 'session', percent: 70, signal: 'yellow', maxWorkers: 4 };
  expect(ruleState(both, { ...FIRED, signalRules: [both] }, 80), 'binds the signal, not the cap').toEqual({ kind: 'binding' });
  const weekStage: UsageRule = { ...WEEK_CAP, stage: 'review' };
  expect(ruleState(WEEK_CAP, { ...FIRED, capRules: [], stageCapRules: { review: [weekStage] } }, 91), 'a stage rule on the same floor keeps its own key').toEqual({ kind: 'weaker' });
  const week70: UsageRule = { source: 'week', percent: 70, maxWorkers: 4 };
  expect(ruleState(week70, FIRED, 91)).toEqual({ kind: 'weaker' });
  expect(ruleState(week70, FIRED, 70), 'at its percent it has fired').toEqual({ kind: 'weaker' });
  expect(ruleState(week70, FIRED, 44)).toEqual({ kind: 'left', percent: 26 });
  expect(ruleState(week70, FIRED, undefined)).toEqual({ kind: 'unread' });
});

test('ruleStateText: valendo, disparou · menos restritiva, faltam n%, pausada with its time (~ for an estimate, nothing for a pause until religar), nothing unread', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const backAt = new Date(now + 52 * 60_000 + 30_000).toISOString();
  expect(ruleStateText({ kind: 'binding' }, now)).toBe('valendo');
  expect(ruleStateText({ kind: 'weaker' }, now)).toBe('disparou · menos restritiva');
  expect(ruleStateText({ kind: 'left', percent: 26 }, now)).toBe('faltam 26%');
  expect(ruleStateText({ kind: 'paused', pause: { rule: WEEK_CAP, until: 'at', backAt, estimate: false } }, now)).toBe('pausada · 52 min');
  expect(ruleStateText({ kind: 'paused', pause: { rule: WEEK_CAP, until: 'reset', backAt, estimate: true } }, now)).toBe('pausada · ~52 min');
  expect(ruleStateText({ kind: 'paused', pause: { rule: WEEK_CAP, until: 'manual', estimate: false } }, now)).toBe('pausada');
  expect(ruleStateText({ kind: 'unread' }, now)).toBe('');
});

test('ruleEffectText uses Settings\' consequence words: the cap, a stage cap, the signal, joined', () => {
  expect(ruleEffectText({ source: 'week', percent: 40, maxWorkers: 4 })).toBe('limitar workers a 4');
  expect(ruleEffectText({ source: 'week', percent: 40, maxWorkers: 0, stage: 'Dev' })).toBe('limitar workers de Dev a 0');
  expect(ruleEffectText({ source: 'session', percent: 60, signal: 'yellow' })).toBe('mudar o sinal para yellow');
  expect(ruleEffectText({ source: 'session', percent: 90, maxWorkers: 1, signal: 'red' })).toBe('limitar workers a 1 · mudar o sinal para red');
});

test('rulesBlocks: one block per measure and agent in MEASURES order, the default agent first, rows by percent with their state; the counts leave paused rules out', () => {
  const codexWeek: UsageRule = { source: 'week', percent: 50, signal: 'red', agent: 'codex' };
  const week70: UsageRule = { source: 'week', percent: 70, maxWorkers: 4 };
  const state: State = { ...STATE, usageRules: [DAY_STAGE, WEEK_CAP, codexWeek, SESSION_FORCE, week70] };
  const effective: EffectiveLimits = { ...FIRED, disabledRules: [{ rule: codexWeek, until: 'manual', estimate: false }] };
  const { blocks, total, fired } = rulesBlocks(state, effective, Date.now());
  expect(blocks.map((b) => [b.label, b.current])).toEqual([
    ['janela da sessão (5h)', undefined], ['janela da semana', 91], ['janela da semana · codex', undefined], ['orçamento por dia', undefined],
  ]);
  expect(blocks[1].rows.map((r) => [r.rule.percent, r.state.kind])).toEqual([[70, 'weaker'], [90, 'binding']]);
  expect(blocks[2].rows.map((r) => r.state.kind)).toEqual(['paused']);
  expect([total, fired]).toEqual([5, 4]);
  expect(rulesBlocks({ ...STATE, usageRules: [] }, NONE, Date.now())).toEqual({ blocks: [], total: 0, fired: 0 });
});
