import { duration } from '../../../../benchmark/format.js';
import type { BenchRun } from '../../../../types.js';
import { MissingLine, ResultCard } from '@/components/benchmark/result/ResultCard';
import { t } from '@/i18n';

/** One row per task of the run's metrics: key, title, time (#466). */
export function TasksCard({ run }: { run: BenchRun }) {
  const title = t('benchmark.result.tasks');
  const meta = t('benchmark.result.delivered', { delivered: run.delivered, total: run.total });
  if (run.metrics === undefined) return <ResultCard title={title} meta={meta}><MissingLine text={t('benchmark.result.noMetrics')} /></ResultCard>;
  return (
    <ResultCard title={title} meta={meta}>
      <div className="divide-y">
        {run.metrics.tasks.map((task) => (
          <div key={task.key} className="grid grid-cols-[62px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-1.5 text-xs">
            <span className="font-mono text-muted-foreground">{task.key}</span>
            <span className="truncate">{task.title}</span>
            <span className="text-muted-foreground">{duration(task.ms)}</span>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}
