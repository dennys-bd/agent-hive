import type { BenchRun, Experiment } from '../../../../types.js';
import { MissingLine } from '@/components/benchmark/result/ResultCard';
import { metricCells } from '@/components/benchmark/result/result-view';
import { t } from '@/i18n';

/** The eight metric cells (#466, the screen's .metrics). */
export function MetricsStrip({ experiment, run }: { experiment: Experiment; run: BenchRun }) {
  const cells = metricCells(experiment, run, Date.now());
  if (cells === undefined) return <div className="rounded-lg border"><MissingLine text={t('benchmark.result.noMetrics')} /></div>;
  return (
    <dl aria-label={t('benchmark.result.metrics')} className="m-0 grid grid-cols-8 divide-x rounded-lg border">
      {cells.map((c) => (
        <div key={c.label} className="flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5">
          <dt className="text-muted-foreground text-xs">{c.label}</dt>
          <dd className="m-0 font-semibold text-base">{c.value}</dd>
          {c.context.map((line) => <small key={line} className="text-[11px] text-muted-foreground">{line}</small>)}
        </div>
      ))}
    </dl>
  );
}
