// Settings › regras' signal rules (#512): one row per consequence, each on its own measure (#526). Pure, so node:test checks it.
import { PLAN_SOURCES, RULE_SIGNALS, type RuleSignal, type RuleSource, type UsageRule } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import type { SettingsProblem } from './settings-form.js';
import { PERCENT_MAX } from './usage.js';

export type EffectKind = 'maxWorkers' | 'signal';
// id: the row's React key, never sent. ruleDrafts splits a rule holding both consequences; rulesFrom folds them back.
export interface RuleDraft { id: string; source: RuleSource; percent: string; stage: string; kind: EffectKind | ''; value: string }
/** One option of a row's consequence select: the total cap, a stage's cap (#475) or the signal. */
export interface Consequence { kind: EffectKind; stage: string }

export const MEASURE_LABEL: Record<RuleSource, MessageKey> = {
  session: 'settings.rules.measure.session', week: 'settings.rules.measure.week', month: 'settings.rules.measure.month', hour: 'settings.rules.measure.hour', day: 'settings.rules.measure.day',
};
const BUDGET_SOURCES: readonly RuleSource[] = ['hour', 'day'];
/** The five measures in ruler order (#526, #929). */
export const MEASURES: readonly RuleSource[] = [...PLAN_SOURCES, ...BUDGET_SOURCES];
/** The measures at least one row uses, in ruler order; an empty row counts so its bar appears with the row. */
export const measuresInUse = (rules: readonly RuleDraft[]): RuleSource[] => MEASURES.filter((s) => rules.some((r) => r.source === s));

export const emptyRule = (source: RuleSource): RuleDraft => ({ id: crypto.randomUUID(), source, percent: '', stage: '', kind: '', value: '' });

export function ruleDrafts(rule: UsageRule): RuleDraft[] {
  const row = (kind: EffectKind, value: string): RuleDraft => ({ id: crypto.randomUUID(), source: rule.source, percent: String(rule.percent), stage: rule.stage ?? '', kind, value });
  return [
    ...(rule.maxWorkers === undefined ? [] : [row('maxWorkers', String(rule.maxWorkers))]),
    ...(rule.signal === undefined ? [] : [row('signal', rule.signal)]),
  ];
}

const effectOf = (row: RuleDraft): Pick<UsageRule, 'maxWorkers' | 'signal'> =>
  row.kind === 'maxWorkers' ? { maxWorkers: Number(row.value) } : { signal: row.value as RuleSignal };
// A rule a row may fold into: same source, percent and stage, and still free of the row's kind.
const foldsInto = (rule: UsageRule, row: RuleDraft): boolean =>
  rule.source === row.source && rule.percent === Number(row.percent) && (rule.stage ?? '') === row.stage && rule[row.kind as EffectKind] === undefined;

/** The rows as usageRules, folding a split rule back so an untouched form saves what it loaded. validateSettings ran first. */
export const rulesFrom = (rows: readonly RuleDraft[]): UsageRule[] => rows.reduce<UsageRule[]>((rules, row) => {
  const i = rules.findIndex((rule) => foldsInto(rule, row));
  if (i !== -1) return rules.map((rule, j) => (j === i ? { ...rule, ...effectOf(row) } : rule));
  return rules.concat({ source: row.source, percent: Number(row.percent), ...effectOf(row), ...(row.stage === '' ? {} : { stage: row.stage }) });
}, []);

const isCount = (text: string): boolean => /^\d+$/.test(text.trim());
export const isRuleValid = (r: RuleDraft): boolean =>
  isCount(r.percent) && Number(r.percent) <= PERCENT_MAX
  && (r.kind === 'maxWorkers' ? isCount(r.value) : r.kind === 'signal' && RULE_SIGNALS.includes(r.value as RuleSignal));

// {n} is the row's position in the whole list: one table lists every rule (#526).
function problemAt(rules: readonly RuleDraft[], i: number, key: MessageKey, vars: Record<string, string> = {}): SettingsProblem {
  return { section: 'rules', message: t(key, { n: i + 1, source: t(MEASURE_LABEL[rules[i].source]), ...vars }) };
}

/** A row not filled whole, then a stage cap naming no stage of the form (#475). A signal row carries no stage by construction. */
export function rulesProblem(rules: readonly RuleDraft[], stageNames: readonly string[]): SettingsProblem | undefined {
  const bad = rules.findIndex((r) => !isRuleValid(r));
  if (bad !== -1) return problemAt(rules, bad, 'settings.rules.error');
  const unknown = rules.findIndex((r) => r.stage !== '' && !stageNames.includes(r.stage));
  return unknown === -1 ? undefined : problemAt(rules, unknown, 'settings.rules.stageUnknown', { stage: rules[unknown].stage });
}

/** The consequence select's options. A stage gone from the form stays on its own row, so the row reads what it holds while validation names it. */
export function consequences(stages: readonly string[], rule: RuleDraft): Consequence[] {
  const names = rule.stage === '' || stages.includes(rule.stage) ? stages : [...stages, rule.stage];
  return [{ kind: 'maxWorkers', stage: '' }, ...names.map((stage) => ({ kind: 'maxWorkers' as const, stage })), { kind: 'signal', stage: '' }];
}

export const consequenceLabel = (c: Consequence): string => {
  if (c.kind === 'signal') return t('settings.rules.effect.signal');
  return c.stage === '' ? t('settings.rules.effect.maxWorkers') : t('settings.rules.effect.stageWorkers', { stage: c.stage });
};

/** The rows with each stage cap under its stage's new name (#861): a row loaded under a name this save renames follows it, so the form neither
 * refuses its own save nor sends an old name. Known ceiling: a row picked in the same save under a name that save renames away follows too. */
export const renamedRuleDrafts = (rows: readonly RuleDraft[], renames: Record<string, string>): RuleDraft[] =>
  rows.map((r) => (r.stage !== '' && Object.hasOwn(renames, r.stage) ? { ...r, stage: renames[r.stage] } : r));
