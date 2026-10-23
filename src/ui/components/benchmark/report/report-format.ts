// The report tab's cell texts (#467): one formatter per cell kind, in the current language's locale. Pure, tested without rendering.
import type { DiffCell, RatioCell, SpreadCell } from '../../../../benchmark/report.js';
import { currentLanguage, formatCount, LOCALE, t, tPlural } from '@/i18n';

export type SpreadKind = 'tokens' | 'cost' | 'time' | 'score';
/** A cell as the table draws it: the value, the muted text beside it (the range, the timeouts, the files), and whether it is the row's best. */
export interface CellText { value: string; sub?: string; isBest: boolean }
// A range's two ends and the unit written once after them
type Ends = [string, string, string];
interface KindFormat { one(n: number): string; ends(min: number, max: number): Ends }

const ABSENT: CellText = { value: '—', isBest: false };
const MINUS = '−'; // the screen's minus sign, not a hyphen
const MILLION = 1_000_000;
const THOUSAND = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const WHOLE_DOLLARS_FROM = 10;

const num = (n: number, digits: number, isFixed = false): string =>
  n.toLocaleString(LOCALE[currentLanguage()], { minimumFractionDigits: isFixed ? digits : 0, maximumFractionDigits: digits });

// Millions with one decimal; under a million whole thousands, a tenth of a thousand tokens is noise. A range takes its max's unit.
// The cut is where thousands would round up to 1000k, so 999.6k reads 1,0M
const tokenUnit = (n: number): { size: number; unit: string; digits: number } =>
  (n >= MILLION - THOUSAND / 2 ?{ size: MILLION, unit: 'M', digits: 1 } : { size: THOUSAND, unit: 'k', digits: 0 });
const tokens = (n: number, max = n): Ends => {
  const { size, unit, digits } = tokenUnit(max);
  return [num(n / size, digits, true), '', unit];
};
const usd = (n: number): string => num(n, n < WHOLE_DOLLARS_FROM ? 1 : 0);
const minutesOf = (ms: number): number => Math.round(ms / MINUTE_MS);
const hours = (minutes: number): string => `${Math.floor(minutes / HOUR_MINUTES)}h${String(minutes % HOUR_MINUTES).padStart(2, '0')}`;

/** A duration as the report writes it: 5h32 from an hour up, 22m under it. */
export function formatDuration(ms: number): string {
  const minutes = minutesOf(ms);
  return minutes < HOUR_MINUTES ? `${minutes}m` : hours(minutes);
}

const KINDS: Record<SpreadKind, KindFormat> = {
  tokens: { one: (n) => tokens(n).join(''), ends: (min, max) => [tokens(min, max)[0], tokens(max)[0], tokens(max)[2]] },
  cost: { one: (n) => `$${usd(n)}`, ends: (min, max) => [usd(min), usd(max), ''] },
  time: {
    one: formatDuration,
    ends: (min, max) => (minutesOf(max) < HOUR_MINUTES ? [String(minutesOf(min)), String(minutesOf(max)), 'm'] : [hours(minutesOf(min)), hours(minutesOf(max)), '']),
  },
  score: { one: (n) => num(n, 1), ends: (min, max) => [num(min, 1), num(max, 1), ''] },
};

// Two ends that write the same (min = max, or a rounding) are one value
function rangeText(format: KindFormat, min: number, max: number): string {
  const [low, high, unit] = format.ends(min, max);
  return low === high ? `${low}${unit}` : `${low}–${high}${unit}`;
}

/** A median cell: the median, then the range, or `timeout ×N` on a time cell some of whose runs timed out (their time is the cut, not a measure). */
export function spreadText(kind: SpreadKind, cell: SpreadCell | undefined): CellText {
  if (cell?.value === undefined) return ABSENT;
  const format = KINDS[kind];
  const { median, min, max } = cell.value;
  const sub = cell.timeouts === undefined ? rangeText(format, min, max) : t('benchmark.report.timeouts', { n: cell.timeouts });
  return { value: format.one(median), sub, isBest: cell.best === true };
}

/** The diff's medians, rounded: `+4.120 −610` and the files; more or fewer lines is not better, so never best. */
export function diffText(cell: DiffCell | undefined): CellText {
  if (cell === undefined) return ABSENT;
  const files = Math.round(cell.files);
  return {
    value: `+${formatCount(Math.round(cell.insertions))} ${MINUS}${formatCount(Math.round(cell.deletions))}`,
    sub: tPlural('benchmark.report.files', files, { n: formatCount(files) }), isBest: false,
  };
}

/** `16/18`; an arm with nothing measured has no ratio. */
export const ratioText = (cell: RatioCell | undefined): CellText =>
  (cell === undefined || cell.total === 0 ? ABSENT : { value: `${cell.passed}/${cell.total}`, isBest: cell.best === true });
