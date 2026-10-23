import type { BenchRun, Experiment, ScenarioResult } from '../../../../types.js';
import { Dot, MissingLine, ResultCard } from '@/components/benchmark/result/ResultCard';
import { lastShot, scenarioTone, scenarioTotals, screenUrl } from '@/components/benchmark/result/result-view';
import { t, tPlural } from '@/i18n';

const SHOT = 'h-[74px] w-full rounded-md border bg-muted';

function Shot({ experimentId, token, scenario }: { experimentId: string; token: string; scenario: ScenarioResult }) {
  const name = lastShot(scenario);
  if (name === undefined) return <div className={`${SHOT} flex items-center justify-center text-[11px] text-muted-foreground`}>{t('benchmark.result.noShot')}</div>;
  return <img src={screenUrl(experimentId, token, name)} alt={t('benchmark.result.shot', { id: scenario.id })} className={`${SHOT} object-cover`} />;
}

/** Each scenario's final screenshot, its state and passed/total (#466). */
export function ScenariosCard({ experiment, run }: { experiment: Experiment; run: BenchRun }) {
  const title = t('benchmark.result.metric.scenarios');
  const scenarios = run.evaluation?.scenarios;
  if (scenarios === undefined) return <ResultCard title={title}><MissingLine text={t('benchmark.result.notEvaluated')} /></ResultCard>;
  const { passed, total, walks } = scenarioTotals(scenarios);
  const meta = `${tPlural('benchmark.result.scenarioCount', scenarios.length, { n: scenarios.length })} × ${tPlural('benchmark.result.walks', walks, { n: walks })} · ${passed}/${total}`;
  const titleOf = (id: string): string => experiment.seed.scenarios.find((s) => s.id === id)?.title ?? '';
  return (
    <ResultCard title={title} meta={meta}>
      <div className="grid grid-cols-3 gap-2.5 px-3.5 py-3">
        {scenarios.map((s) => (
          <div key={s.id} className="flex min-w-0 flex-col gap-1.5">
            <Shot experimentId={experiment.id} token={run.token} scenario={s} />
            <div className="flex items-center gap-1.5 text-xs">
              <Dot tone={scenarioTone(s)} />
              <span className="font-mono text-muted-foreground">{s.id}</span>
              <span className="min-w-0 flex-1 truncate">{titleOf(s.id)}</span>
              <span className="text-muted-foreground">{`${s.passed}/${s.total}`}</span>
            </div>
          </div>
        ))}
      </div>
    </ResultCard>
  );
}
