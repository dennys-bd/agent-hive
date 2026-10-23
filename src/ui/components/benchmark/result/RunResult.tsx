import { useState } from 'react';
import { HASH_SHOWN } from '../../../../benchmark/format.js';
import type { BenchRun, Experiment } from '../../../../types.js';
import { BenchmarkPrDialog } from '@/components/benchmark/pr/BenchmarkPrDialog';
import { CollectorsCard } from '@/components/benchmark/result/CollectorsCard';
import { JudgeCard } from '@/components/benchmark/result/JudgeCard';
import { MetricsStrip } from '@/components/benchmark/result/MetricsStrip';
import { RegistryCard } from '@/components/benchmark/result/RegistryCard';
import { Chip } from '@/components/benchmark/result/ResultCard';
import { runChip } from '@/components/benchmark/result/result-view';
import { evaluateRun, openHive } from '@/components/benchmark/result/run-api';
import { ScenariosCard } from '@/components/benchmark/result/ScenariosCard';
import { TasksCard } from '@/components/benchmark/result/TasksCard';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export interface RunResultProps { experiment: Experiment; run: BenchRun }

/** One run's result (#466, #s-resultado of benchmark.hv.html): the top line with its three actions, the metrics and the two columns, in the
 *  execution tab's result slot (#465), which draws the back line. It owns the PR dialog's open state. */
export function RunResult({ experiment, run }: RunResultProps) {
  const [isJudging, setJudging] = useState(false);
  const [isPrOpen, setPrOpen] = useState(false);
  const arm = experiment.arms.find((a) => a.id === run.armId);
  const chip = runChip(run);
  const judge = async (): Promise<void> => {
    setJudging(true);
    try { await evaluateRun(experiment.id, run.token); } finally { setJudging(false); }
  };
  return (
    <section aria-label={t('benchmark.result.title')} className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5 text-[13px]">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-accent font-mono font-semibold text-[11px]">{arm?.letter}</span>
        <b className="font-semibold">{`${arm?.name ?? ''} · ${t('benchmark.result.pair', { round: run.round })}`}</b>
        <span className="font-mono text-muted-foreground text-xs">{run.token.slice(0, HASH_SHOWN)}</span>
        <Chip tone={chip.tone}>{chip.text}</Chip>
        {run.interventions.length > 0 && <Chip tone="yellow">{t('benchmark.result.intervened', { n: run.interventions.length })}</Chip>}
        <span className="flex-1" />
        <Button type="button" size="sm" variant="outline" disabled={isJudging} onClick={() => void judge()}>{t('benchmark.result.evaluate')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void openHive(experiment.id, run.token)}>{t('benchmark.result.openHive')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setPrOpen(true)}>{t('benchmark.result.openPr')}</Button>
      </div>
      <MetricsStrip experiment={experiment} run={run} />
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-3.5">
        <div className="flex min-w-0 flex-col gap-3.5"><JudgeCard run={run} /><ScenariosCard experiment={experiment} run={run} /><CollectorsCard run={run} /></div>
        <div className="flex min-w-0 flex-col gap-3.5"><RegistryCard experiment={experiment} run={run} /><TasksCard run={run} /></div>
      </div>
      {isPrOpen && <BenchmarkPrDialog experiment={experiment} token={run.token} onClose={() => setPrOpen(false)} />}
    </section>
  );
}
