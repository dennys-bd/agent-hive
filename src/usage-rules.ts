import type { Budget, Signal, UsageLimits, UsageRule, UsageSample } from './types.js';
import { usageTotals } from './usage.js';

export const SIGNAL_RANK: Record<Signal, number> = { green: 0, yellow: 1, red: 2 };
const PERCENT = 100;

export function worstSignal(a: Signal, b: Signal): Signal {
  return SIGNAL_RANK[b] > SIGNAL_RANK[a] ? b : a;
}

// Multiply before dividing: token counts are integers, so an exact share (1_140_000 of 2_000_000) reads 57, not 56.99…
function share(used: number, limit: number | undefined): number {
  return limit ? (used * PERCENT) / limit : 0; // absent or 0 = no limit for this window, same as hasBudget
}

/** Share of the budget used, in percent, over the windows that have a limit; no samples or no limit reads as 0. */
export function usedPercent(usage: UsageSample[], budget: Budget, now: number): number {
  const { hour, day } = usageTotals(usage, now);
  return Math.max(share(hour, budget.maxTokensPerHour), share(day, budget.maxTokensPerDay));
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Every rule at or below the used percent fires; the worst signal and the smallest cap among them win. Array order is irrelevant. */
export function applyUsageRules(usage: UsageSample[], budget: Budget, rules: UsageRule[], now: number): UsageLimits {
  const used = usedPercent(usage, budget, now);
  return rules
    .filter((rule) => rule.percent <= used)
    .reduce<UsageLimits>((limits, rule) => {
      const maxWorkers = minDefined(limits.maxWorkers, rule.maxWorkers);
      return {
        signal: rule.signal ? worstSignal(limits.signal, rule.signal) : limits.signal,
        ...(maxWorkers === undefined ? {} : { maxWorkers }), // no key when no rule caps, like parseUsageRule
      };
    }, { signal: 'green' });
}
