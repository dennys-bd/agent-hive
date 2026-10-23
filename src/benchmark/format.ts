// The benchmark's number formats (#476): report.md, the PR body (#477) and the result screen (#466) show the same numbers the same way.
// Pure and free of node:*, so the browser imports it too; report-md.ts writes files and cannot be.
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const MILLION = 1_000_000;
export const HASH_SHOWN = 6; // the screens show a hash's first six characters
export type Format = (value: number) => string;

// A median of two may be a half; more than two decimals is noise in a table
export const plain: Format = (value) => String(Number(value.toFixed(2)));
export const millions: Format = (value) => `${(value / MILLION).toFixed(1)}M`;
export const usd: Format = (value) => `$${plain(value)}`;
export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours === 0 ? `${minutes}m` : `${hours}h${String(minutes % HOUR_MINUTES).padStart(2, '0')}`;
}
