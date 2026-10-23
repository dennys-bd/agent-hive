// The Executar experimento confirmation's words (#465, benchmark.hv.html's dlg-run), built from the experiment: a limit clause only for what the
// pace sets, so a pace with no until or no cap never prints an empty one. Tested without rendering.
import type { BenchPace, Experiment } from '../../../../types';
import { currentLanguage, LOCALE, t } from '@/i18n';

const THOUSAND = 1_000;
const MILLION = 1_000_000;

/** 1,9M / 1.9M, 4M, 850k: a run's tokens and the token cap, in the language's decimals (usage.ts's fmt writes 1.9M and 4.0M). */
export function tokensText(n: number): string {
  const locale = LOCALE[currentLanguage()];
  if (n < MILLION) return `${Math.round(n / THOUSAND).toLocaleString(locale)}k`;
  return `${(n / MILLION).toLocaleString(locale, { maximumFractionDigits: 1 })}M`;
}

export const armsText = (n: number): string => (n === 1 ? t('benchmark.execution.arms.one') : t('benchmark.execution.arms.other', { n }));
export const pairsText = (n: number): string => (n === 1 ? t('benchmark.execution.pairs.one') : t('benchmark.execution.pairs.other', { n }));

/** The dialog's context line: `<name> · N braços · M pares`. */
export const runContext = (e: Experiment): string => `${e.name} · ${armsText(e.arms.length)} · ${pairsText(e.pace.pairs)}`;

// acima de X tokens ou P% do plano; undefined when the pace sets no cap
function capClause({ cap }: BenchPace): string | undefined {
  const limits = [
    cap.tokens === undefined ? undefined : t('benchmark.execution.run.tokens', { n: tokensText(cap.tokens) }),
    cap.planPercent === undefined ? undefined : t('benchmark.execution.run.plan', { p: cap.planPercent }),
  ].filter((limit): limit is string => limit !== undefined);
  return limits.length === 0 ? undefined : t('benchmark.execution.run.above', { limit: limits.join(` ${t('benchmark.execution.run.or')} `) });
}

// nenhum par novo começa depois de HH:MM nem acima de …: undefined when the pace sets neither
function limitSentence(pace: BenchPace): string | undefined {
  const after = pace.until === undefined ? undefined : t('benchmark.execution.run.after', { time: pace.until });
  const above = capClause(pace);
  if (after === undefined && above === undefined) return undefined;
  const clauses = after !== undefined && above !== undefined ? `${after} ${t('benchmark.execution.run.nor')} ${above}` : (after ?? above ?? '');
  return `${t('benchmark.execution.run.limit')} ${clauses}.`;
}

/** The dialog's text: the pairs, one run per arm per pair, the workers per arm, then the limit sentence when the pace sets one. */
export function runText(e: Experiment): string {
  const lead = t('benchmark.execution.run.text', { pairs: pairsText(e.pace.pairs), workers: e.pace.workersPerArm });
  const limit = limitSentence(e.pace);
  return limit === undefined ? lead : `${lead} ${limit}`;
}
