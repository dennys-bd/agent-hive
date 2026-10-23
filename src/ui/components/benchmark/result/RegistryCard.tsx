import { useId, useState } from 'react';
import type { BenchRun, Experiment } from '../../../../types.js';
import { Dot, ResultCard } from '@/components/benchmark/result/ResultCard';
import { setInMedian } from '@/components/benchmark/result/run-api';
import { sleepsInRound } from '@/components/benchmark/result/result-view';
import { Switch } from '@/components/ui/switch';
import { t, tPlural } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

/** The run's interventions, the round's sleeps and, for a run with interventions, its median override (#466). The report's filter only
 *  touches runs with interventions, so the toggle would do nothing on any other run. The new value arrives through /events. */
export function RegistryCard({ experiment, run }: { experiment: Experiment; run: BenchRun }) {
  const switchId = useId();
  const [isSaving, setSaving] = useState(false);
  // One PATCH at a time: the switch only moves when /events brings the new value, so a quick second click would repeat the first
  const toggle = (isIn: boolean): void => {
    setSaving(true);
    void setInMedian(experiment.id, run.token, isIn).finally(() => setSaving(false));
  };
  const n = run.interventions.length;
  const slept = sleepsInRound(experiment, run.round);
  const meta = `${tPlural('benchmark.result.interventionCount', n, { n })} · ${tPlural('benchmark.result.sleepCount', slept, { n: slept })}`;
  return (
    <ResultCard title={t('benchmark.result.registry')} meta={meta}>
      {run.interventions.map((iv) => (
        <div key={`${iv.at} ${iv.action}`} className="flex flex-col gap-0.5 px-3.5 py-2 text-xs">
          <span className="flex items-center gap-1.5"><Dot tone="yellow" /><span className="font-mono text-muted-foreground">{clockOf(new Date(iv.at))}</span><span>{iv.action}</span></span>
          <p className="m-0 pl-3 text-muted-foreground leading-[17px]">{`${iv.detail} · ${t('benchmark.result.byYou')}`}</p>
        </div>
      ))}
      {n > 0 && (
        <div className="flex items-center gap-2 border-t px-3.5 py-2 text-muted-foreground text-xs">
          <label htmlFor={switchId} className="flex-1">{t('benchmark.result.inMedian')}</label>
          <Switch id={switchId} checked={run.inMedian ?? true} disabled={isSaving} onCheckedChange={toggle} />
        </div>
      )}
    </ResultCard>
  );
}
