import { HASH_SHOWN } from '../../../../benchmark/format.js';
import type { BenchRun } from '../../../../types.js';
import { MissingLine, ResultCard } from '@/components/benchmark/result/ResultCard';
import { t } from '@/i18n';

const SCORE_MAX = 5; // the rubric scores 1–5

/** The judge's scores with their evidence (#466). The rubric has no version: its hash names it, by the first six characters. */
export function JudgeCard({ run }: { run: BenchRun }) {
  const title = t('benchmark.result.judge');
  const judge = run.evaluation?.judge;
  if (judge === undefined) return <ResultCard title={title}><MissingLine text={t('benchmark.result.notEvaluated')} /></ResultCard>;
  const who = judge.model === undefined ? judge.agent : `${judge.agent} · ${judge.model}`;
  return (
    <ResultCard title={title} meta={`${who} · ${t('benchmark.result.rubric', { hash: judge.rubricHash.slice(0, HASH_SHOWN) })}`}>
      <div className="divide-y">
        {judge.scores.map((s) => (
          <div key={s.dimension} className="grid grid-cols-[36px_130px_minmax(0,1fr)] items-baseline gap-3 px-3.5 py-2 text-[13px]">
            <b className="font-semibold text-[15px]">{`${s.score}/${SCORE_MAX}`}</b>
            <span>{s.dimension}</span>
            <p className="m-0 text-muted-foreground text-xs leading-[19px]">{s.evidence}</p>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}
