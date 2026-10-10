// The signal rules' ruler (#512): which signal each stretch of 0–100% sits in, and one step per percent that holds a rule. Pure.
import type { RuleSignal, Signal } from '../../types.js';
import { t } from '../i18n.js';
import { isRuleValid, type RuleDraft } from './settings-rules.js';
import { PERCENT_MAX } from './usage.js';

export interface Zone { signal: Signal; from: number; to: number }
export interface RuleStep { percent: number; labels: string[] }

/** The worst fired signal wins, as applyUsageRules does: red holds from its lowest rule, yellow from its own lowest below that. */
export function signalZones(rows: readonly RuleDraft[]): Zone[] {
  const lowest = (signal: RuleSignal): number =>
    Math.min(PERCENT_MAX, ...rows.filter((r) => isRuleValid(r) && r.kind === 'signal' && r.value === signal).map((r) => Number(r.percent)));
  const red = lowest('red');
  const yellow = Math.min(lowest('yellow'), red);
  const zones: Zone[] = [{ signal: 'green', from: 0, to: yellow }, { signal: 'yellow', from: yellow, to: red }, { signal: 'red', from: red, to: PERCENT_MAX }];
  return zones.filter((z) => z.to > z.from);
}

const workers = (n: number): string => t(n === 1 ? 'settings.rules.workers.one' : 'settings.rules.workers.other', { n });
function stepLabel(r: RuleDraft): string {
  if (r.kind === 'signal') return t('settings.rules.signal', { signal: r.value });
  return r.stage === '' ? workers(Number(r.value)) : t('settings.rules.stage', { stage: r.stage, workers: workers(Number(r.value)) });
}

/** One step per percent holding a complete row, ascending; its labels in draft order. */
export function ruleSteps(rows: readonly RuleDraft[]): RuleStep[] {
  const valid = rows.filter(isRuleValid);
  const percents = [...new Set(valid.map((r) => Number(r.percent)))].sort((a, b) => a - b);
  return percents.map((percent) => ({ percent, labels: valid.filter((r) => Number(r.percent) === percent).map(stepLabel) }));
}
