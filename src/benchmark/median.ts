// The median and range of the benchmark report (#476). An even count's median is the mean of its two middles, the standard one, so a
// judge's score may read 4.5. Pure.
export interface Spread { median: number; min: number; max: number; n: number }

/** The median, min, max and count of the values; undefined for none. */
export function spread(values: readonly number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
}

/** The key of the unique best defined value. A tie for the best, or fewer than two values to compare, marks none: "marked once" (#476). */
export function bestOf(values: Record<string, number | undefined>, direction: 'low' | 'high'): string | undefined {
  const defined = Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined);
  if (defined.length < 2) return undefined;
  const pick = direction === 'low' ? Math.min : Math.max;
  const best = pick(...defined.map(([, value]) => value));
  const holders = defined.filter(([, value]) => value === best);
  return holders.length === 1 ? holders[0][0] : undefined;
}
