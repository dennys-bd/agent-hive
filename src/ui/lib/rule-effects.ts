// The rules button's and panel's reads (#224), and the rule helpers the search's pausar regra › shares (#584). Pure, no React, so a lib
// never imports a component.
import { agentName, liveDefaultAgent } from '../../agents.js';
import { type AgentId, DEFAULT_AGENT, type DisabledRuleStatus, type EffectiveLimits, type State, type UsageRule } from '../../types.js';
import { t } from '../i18n.js';
import { consequenceLabel, MEASURE_LABEL, rulerRows, rulersInUse } from './settings-rules.js';
import { describeRules, sourcePercent, timeLeft } from './usage.js';

export type RulesForm = 'full' | 'short';
export type RuleState =
  | { kind: 'binding' }
  | { kind: 'weaker' }
  | { kind: 'left'; percent: number }
  | { kind: 'paused'; pause: DisabledRuleStatus }
  | { kind: 'unread' };
export interface RuleRow { rule: UsageRule; state: RuleState }
export interface RulesBlock { key: string; label: string; current?: number; rows: RuleRow[] }
export interface RulesOverview { blocks: RulesBlock[]; total: number; fired: number }

// Two rules are the same one when they share a source, a floor, a stage and an agent (#929): the payload crosses JSON, so identity is lost.
/** The search's pausar regra › reads the rules through these three too (#584). */
export const ruleKey = (rule: UsageRule): string => `${rule.source}-${rule.percent}-${rule.stage ?? ''}-${rule.agent ?? ''}`;

/** The fired rules in force, each once: the signal's, the cap's, then every stage cap's. */
export function firedRules(effective: EffectiveLimits): UsageRule[] {
  const all = [...effective.signalRules, ...effective.capRules, ...Object.values(effective.stageCapRules).flat()];
  return all.filter((rule, i) => all.findIndex((other) => ruleKey(other) === ruleKey(rule)) === i);
}

/** `semana ≥ 90% · codex → máx 2 workers`: the rule, its agent when it is not the default one (#929), then what it does. */
export function ruleLabel(rule: UsageRule, defaultAgent: AgentId = DEFAULT_AGENT): string {
  const effects = [
    ...(rule.signal ? [rule.signal] : []),
    ...(rule.maxWorkers === undefined ? [] : [rule.stage ? t('footer.rule.stageCap', { stage: rule.stage, n: rule.maxWorkers }) : t('footer.rule.cap', { n: rule.maxWorkers })]),
  ];
  return `${describeRules([rule], defaultAgent)} → ${effects.join(' · ')}`;
}

/** The button's effects (#224): the total cap, each stage its fired stage rules cap (stageCapRules' key order), then the signal. A stage cap
 * Stage.maxWorkers alone sets has no stageCapRules key, and the manual signal is not a rule: neither shows. */
export function effectsInForce(effective: EffectiveLimits): string[] {
  const { floor, capRules, signalRules, stageCaps, stageCapRules } = effective;
  const cap = capRules.length > 0 && floor.maxWorkers !== undefined ? [t('footer.rule.cap', { n: floor.maxWorkers })] : [];
  const stages = Object.keys(stageCapRules)
    .filter((stage) => stageCapRules[stage].length > 0 && stageCaps[stage] !== undefined)
    .map((stage) => t('footer.rules.stage', { stage, n: stageCaps[stage] }));
  const signal = signalRules.length > 0 ? [t('footer.rules.signal', { signal: floor.signal })] : [];
  return [...cap, ...stages, ...signal];
}

/** The button's text and title: nenhuma ativa with no effect; short keeps the first effect and counts the rest. */
export function rulesLabel(effects: readonly string[], form: RulesForm): { text: string; title?: string } {
  if (effects.length === 0) return { text: t('footer.rules.none') };
  const all = effects.join(' · ');
  const text = form === 'short' && effects.length > 1 ? t('footer.rules.more', { first: effects[0], n: effects.length - 1 }) : all;
  return { text, title: t('footer.rules.title', { effects: all }) };
}

/** A rule's state in the panel: paused first; binding when it is behind any effect in force, a tie included; then by its measure's reading. */
export function ruleState(rule: UsageRule, effective: EffectiveLimits, current: number | undefined): RuleState {
  const key = ruleKey(rule);
  const pause = effective.disabledRules.find((status) => ruleKey(status.rule) === key);
  if (pause) return { kind: 'paused', pause };
  if (firedRules(effective).some((other) => ruleKey(other) === key)) return { kind: 'binding' };
  if (current === undefined) return { kind: 'unread' };
  return current >= rule.percent ? { kind: 'weaker' } : { kind: 'left', percent: rule.percent - current };
}

/** The row's right-hand text. A paused rule reads as the footer's did: `~` when the end is an estimate, no time for a pause until religar. */
export function ruleStateText(state: RuleState, now: number): string {
  switch (state.kind) {
    case 'binding': return t('rules.panel.binding');
    case 'weaker': return t('rules.panel.weaker');
    case 'left': return t('rules.panel.left', { n: state.percent });
    case 'unread': return '';
    case 'paused': {
      const { backAt, estimate } = state.pause;
      return backAt === undefined ? t('footer.paused') : `${t('footer.paused')} · ${estimate ? '~' : ''}${timeLeft(backAt, now)}`;
    }
  }
}

/** A rule's effects in Settings' consequence words, so the panel and Settings say a rule the same way: the cap first, then the signal. */
export function ruleEffectText(rule: UsageRule): string {
  const cap = rule.maxWorkers === undefined ? [] : [`${consequenceLabel({ kind: 'maxWorkers', stage: rule.stage ?? '' })} ${rule.maxWorkers}`];
  const signal = rule.signal === undefined ? [] : [`${consequenceLabel({ kind: 'signal', stage: '' })} ${rule.signal}`];
  return [...cap, ...signal].join(' · ');
}

const FIRED_KINDS: readonly RuleState['kind'][] = ['binding', 'weaker'];

/** The panel's blocks, grouped as Settings' rulers (#526, #929), each rule's rows by percent, and the header's counts (a paused rule is not
 * acting, so it does not count as fired). */
export function rulesBlocks(state: Pick<State, 'usageRules' | 'usage' | 'budget' | 'rateLimits' | 'defaultAgent'>, effective: EffectiveLimits, now: number): RulesOverview {
  const defaultAgent = liveDefaultAgent(state);
  const blocks = rulersInUse(state.usageRules, defaultAgent).map((ruler): RulesBlock => {
    const current = sourcePercent(state, ruler, now);
    const rows = [...rulerRows(state.usageRules, ruler, defaultAgent)].sort((a, b) => a.percent - b.percent)
      .map((rule): RuleRow => ({ rule, state: ruleState(rule, effective, current) }));
    const name = t(MEASURE_LABEL[ruler.source]);
    return { key: `${ruler.source}:${ruler.agent ?? ''}`, label: ruler.agent === undefined ? name : `${name} · ${agentName(ruler.agent)}`, current, rows };
  });
  const fired = blocks.flatMap((block) => block.rows).filter((row) => FIRED_KINDS.includes(row.state.kind)).length;
  return { blocks, total: state.usageRules.length, fired };
}
