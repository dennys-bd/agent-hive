import type { BenchRun } from '../../../../types.js';
import { Dot, MissingLine, ResultCard } from '@/components/benchmark/result/ResultCard';
import { collectorView } from '@/components/benchmark/result/result-view';
import { t, tPlural } from '@/i18n';

/** The static collectors' states and summaries (#466). */
export function CollectorsCard({ run }: { run: BenchRun }) {
  const title = t('benchmark.result.collectors');
  const collectors = run.evaluation?.collectors;
  if (collectors === undefined) return <ResultCard title={title}><MissingLine text={t('benchmark.result.notEvaluated')} /></ResultCard>;
  return (
    <ResultCard title={title} meta={tPlural('benchmark.result.collectorCount', collectors.length, { n: collectors.length })}>
      <div className="divide-y">
        {collectors.map((c) => {
          const view = collectorView(c);
          return (
            <div key={c.name} className="grid grid-cols-[140px_110px_minmax(0,1fr)] items-baseline gap-3 px-3.5 py-2 text-[13px]">
              <span className="font-mono text-xs">{c.name}</span>
              <span className="flex items-center gap-1.5 text-xs"><Dot tone={view.tone} />{view.text}</span>
              <p className="m-0 text-muted-foreground text-xs leading-[17px]">{view.summary}</p>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}
