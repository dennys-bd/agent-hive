import { liveDefaultAgent } from './agents.js';
import { type DisabledRule, type DisabledRuleStatus, type DisableUntil, type RateLimits, type PlanSource, RULE_SOURCES, type RuleSource, type Signal, type Stage, type State, type UsageLimits, type UsageRule, type UsageSample } from './types.js';
import { DAY_MS, HOUR_MS, usageTotals } from './usage.js';

export const SIGNAL_RANK: Record<Signal, number> = { green: 0, yellow: 1, red: 2 };
const PERCENT = 100;
/** The plan window each plan source reads; per-model weekly windows (seven_day_<model>) stay display-only. */
export const PLAN_WINDOW: Record<PlanSource, string> = { session: 'five_hour', week: 'seven_day', month: 'thirty_day' }; // month: #929, Codex's free plan

export function worstSignal(a: Signal, b: Signal): Signal {
  return SIGNAL_RANK[b] > SIGNAL_RANK[a] ? b : a;
}

// Multiply before dividing: token counts are integers, so an exact share (1_140_000 of 2_000_000) reads 57, not 56.99…
function share(used: number, limit: number | undefined): number {
  return limit ? (used * PERCENT) / limit : 0; // absent or 0 = no limit for this window, same as hasBudget
}

// No data = no restriction. A window past its reset has reset even when the reader has not caught up (it can fail for hours on a bad token).
function windowPercent(reading: RateLimits | undefined, key: string, now: number): number {
  const window = reading?.windows[key];
  return window === undefined || Date.parse(window.resetsAt) <= now ? 0 : window.usedPercent;
}

/** What a rule reads (#929): the budget and its samples, every agent's plan reading, and the default agent a rule without one reads. */
export type RuleState = Pick<State, 'usage' | 'budget' | 'rateLimits' | 'defaultAgent'>;
/** A rule's percent right now (#929): two rules on one plan source can read two agents, so every check reads its rule's own. */
export type RulePercent = (rule: Pick<UsageRule, 'source' | 'agent'>) => number;

/** The plan reading a rule compares (#929): its agent's, or the default agent's. */
export const planReading = (state: Pick<State, 'rateLimits' | 'defaultAgent'>, rule: Pick<UsageRule, 'agent'>): RateLimits | undefined =>
  state.rateLimits?.[rule.agent ?? liveDefaultAgent(state)];

/** Each rule's percent: the budget shares over the samples (every agent's tokens), a plan window as its agent last read it. */
export function rulePercents(state: RuleState, now: number): RulePercent {
  const { hour, day } = usageTotals(state.usage, now);
  return (rule) => {
    if (rule.source === 'hour') return share(hour, state.budget.maxTokensPerHour);
    if (rule.source === 'day') return share(day, state.budget.maxTokensPerDay);
    return windowPercent(planReading(state, rule), PLAN_WINDOW[rule.source], now);
  };
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Every rule whose percent reads at or above its floor; order preserved. */
export function firedRules(percent: RulePercent, rules: UsageRule[]): UsageRule[] {
  return rules.filter((rule) => percent(rule) >= rule.percent);
}

/** A rule that caps the total (#475): one without a stage. Only these reach the floor, capRules and the header. */
export const isGlobalRule = (rule: UsageRule): boolean => rule.stage === undefined;

/** Every rule whose source is at or above its percent fires; the worst signal and the smallest cap among them win. Array order is irrelevant.
 * A stage rule (#475) is left to stageCaps. */
export function applyUsageRules(percent: RulePercent, rules: UsageRule[]): UsageLimits {
  return firedRules(percent, rules)
    .filter(isGlobalRule)
    .reduce<UsageLimits>((limits, rule) => {
      const maxWorkers = minDefined(limits.maxWorkers, rule.maxWorkers);
      return {
        signal: rule.signal ? worstSignal(limits.signal, rule.signal) : limits.signal,
        ...(maxWorkers === undefined ? {} : { maxWorkers }), // no key when no rule caps, like parseUsageRule
      };
    }, { signal: 'green' });
}

/** Each stage's effective cap (#475): the smallest of its own maxWorkers and the maxWorkers of every fired rule naming it, as the global cap
 * takes the smallest. A stage with neither has no key. Pure. */
export function stageCaps(stages: Stage[], fired: UsageRule[]): Record<string, number> {
  return Object.fromEntries(stages.flatMap((stage) => {
    const cap = fired.reduce((min, rule) => (rule.stage === stage.name ? minDefined(min, rule.maxWorkers) : min), stage.maxWorkers);
    return cap === undefined ? [] : [[stage.name, cap]];
  }));
}

/** The fired stage rules sitting at each stage's cap (#475): what the strip names. A cap set by Stage.maxWorkers alone has no key. */
export function stageCapRules(caps: Record<string, number>, fired: UsageRule[]): Record<string, UsageRule[]> {
  return Object.fromEntries(Object.entries(caps).flatMap(([name, cap]) => {
    const rules = fired.filter((rule) => rule.stage === name && rule.maxWorkers === cap);
    return rules.length === 0 ? [] : [[name, rules]];
  }));
}

/** A rule's identity across JSON (#297): its source and its percent, as the strip groups them. */
export const sameRule = (a: Pick<UsageRule, 'source' | 'percent'>, b: Pick<UsageRule, 'source' | 'percent'>): boolean =>
  a.source === b.source && a.percent === b.percent;

/** The rules minus every one a disable names (#297): what effectiveLimits hands firedRules and applyUsageRules. */
export const activeRules = (rules: UsageRule[], disabled: DisabledRule[]): UsageRule[] =>
  rules.filter((rule) => !disabled.some((entry) => sameRule(entry, rule)));

/**
 * When a rolling budget window would fall below `percent` of `limit` if no new token arrived (#297): the samples inside the window leave
 * oldest first (State.usage is oldest first), and the one whose leaving brings the total under answers, at its time plus the window.
 * Undefined without a limit, or when even an empty window would not fall under.
 */
export function rollingBackAt(usage: UsageSample[], windowMs: number, limit: number | undefined, percent: number, now: number): string | undefined {
  if (!limit) return undefined; // absent or 0 = no limit, as in share()
  const inside = usage.filter((sample) => now - Date.parse(sample.at) < windowMs);
  let left = inside.reduce((sum, sample) => sum + sample.tokens, 0);
  for (const sample of inside) {
    left -= sample.tokens;
    if (left * PERCENT < percent * limit) return new Date(Date.parse(sample.at) + windowMs).toISOString(); // share()'s comparison, multiplied out
  }
  return undefined;
}

/** When a reset disable's rule is expected back (#297): a plan rule at its window's reset, a budget rule at rollingBackAt's estimate. */
export function ruleBackAt(rule: Pick<UsageRule, 'source' | 'percent' | 'agent'>, state: RuleState, now: number): string | undefined {
  switch (rule.source) {
    case 'session':
    case 'week':
    case 'month': return planReading(state, rule)?.windows[PLAN_WINDOW[rule.source]]?.resetsAt; // #929: its own agent's window
    case 'hour': return rollingBackAt(state.usage, HOUR_MS, state.budget.maxTokensPerHour, rule.percent, now);
    case 'day': return rollingBackAt(state.usage, DAY_MS, state.budget.maxTokensPerDay, rule.percent, now);
  }
}

/** Whether a disable has run its course at `now` (#297): reset once its rule reads below the percent on its agent's reading (#929), at from
 * its time, manual never. */
export function disableExpired(entry: DisabledRule, percent: RulePercent, now: number): boolean {
  switch (entry.until.kind) {
    case 'reset': return percent(entry) < entry.percent;
    case 'at': return now >= Date.parse(entry.until.at);
    case 'manual': return false;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Only the form toISOString writes, which is what the UI sends: a looser Date.parse form could read differently on another engine.
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const isRuleSource = (value: unknown): value is RuleSource => RULE_SOURCES.includes(value as RuleSource);
export const isPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** reset, manual, or at with an ISO date (#297). The route adds that `at` must be in the future; the loader keeps a past one, reduce drops it. */
export function isDisableUntil(value: unknown): value is DisableUntil {
  if (!isObject(value)) return false;
  return value.kind === 'reset' || value.kind === 'manual' || (value.kind === 'at' && isIsoDate(value.at));
}

/** A disable in the shape the routes accept (#297): a known source, a finite percent and a valid until. */
export const isDisabledRule = (value: unknown): value is DisabledRule =>
  isObject(value) && isRuleSource(value.source) && isPercent(value.percent) && isDisableUntil(value.until);

/** A disable copied field by field (#297): nothing else a hand-edited state.json carries rides along. */
export const copyDisabledRule = ({ source, percent, until }: DisabledRule): DisabledRule => ({
  source, percent, until: until.kind === 'at' ? { kind: 'at', at: until.at } : until.kind === 'reset' ? { kind: 'reset' } : { kind: 'manual' },
});

// Where a disable's rule is expected back (#297): a reset one where ruleBackAt says, an at one at its time, a manual one never.
function backAtOf(entry: DisabledRule, rule: UsageRule, state: RuleState, now: number): string | undefined {
  switch (entry.until.kind) {
    case 'reset': return ruleBackAt(rule, state, now);
    case 'at': return entry.until.at;
    case 'manual': return undefined;
  }
}

/** Every disabled rule of the table, in its order, with when it is expected back (#297): what effectiveLimits reports and the strip shows.
 * ponytail: two rows with the same source + percent are one rule to a disable (the strip's sameRule); each such row is listed. */
export function disabledStatuses(state: Pick<State, 'usageRules'> & RuleState, disabled: DisabledRule[], now: number): DisabledRuleStatus[] {
  return state.usageRules.flatMap((rule) => {
    const entry = disabled.find((d) => sameRule(d, rule));
    if (!entry) return [];
    const backAt = backAtOf(entry, rule, state, now);
    const estimate = entry.until.kind === 'reset' && (rule.source === 'hour' || rule.source === 'day'); // a rolling window has no fixed reset
    return [{ rule, until: entry.until.kind, ...(backAt === undefined ? {} : { backAt }), estimate }];
  });
}

/** The disables still in force at `now` (#297). The state itself when none expired, so an event that changes nothing still returns it. */
export function dropExpiredDisables(state: State, now: number): State {
  if (state.disabledRules.length === 0) return state;
  const percent = rulePercents(state, now);
  const kept = state.disabledRules.filter((entry) => !disableExpired(entry, percent, now));
  return kept.length === state.disabledRules.length ? state : { ...state, disabledRules: kept };
}

/** desligar (#297): only a rule of the table that fires right now and is not disabled yet; anything else returns the state itself. */
export function disableRule(state: State, entry: DisabledRule, now: number): State {
  const known = state.usageRules.some((rule) => sameRule(rule, entry));
  if (!known || rulePercents(state, now)(entry) < entry.percent || state.disabledRules.some((d) => sameRule(d, entry))) return state;
  return { ...state, disabledRules: [...state.disabledRules, entry] };
}

/** religar (#297): the disable goes at once; the state itself when there was none. */
export function enableRule(state: State, pair: Pick<DisabledRule, 'source' | 'percent'>): State {
  const kept = state.disabledRules.filter((entry) => !sameRule(entry, pair));
  return kept.length === state.disabledRules.length ? state : { ...state, disabledRules: kept };
}

/** The disables whose source + percent still name a rule of `rules` (#297): a disable must not outlive its rule, nor attach to another. */
export const namedDisables = (disabled: DisabledRule[], rules: UsageRule[]): DisabledRule[] =>
  disabled.filter((entry) => rules.some((rule) => sameRule(rule, entry)));
