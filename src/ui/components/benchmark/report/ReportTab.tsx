import { MoonIcon } from 'lucide-react';
import { useState } from 'react';
import { type BenchReport, evaluableTokens, type ReportFilter } from '../../../../benchmark/report.js';
import type { Experiment } from '../../../../types.js';
import { BenchmarkPrDialog } from '@/components/benchmark/pr/BenchmarkPrDialog';
import { downloadReport, evaluateAgain } from '@/components/benchmark/report/report-actions';
import { formatDuration } from '@/components/benchmark/report/report-format';
import { ReportTable } from '@/components/benchmark/report/ReportTable';
import { type ReportState, useReport } from '@/components/benchmark/report/use-report';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { statusOf } from '@/hooks/use-plugins';
import { t, tPlural } from '@/i18n';
import { TOKEN_SHOWN } from '@/lib/benchmark-pr';

const HTTP_CONFLICT = 409;
const FILTERS: readonly ReportFilter[] = ['in', 'out'];

interface TopLineProps { report?: BenchReport; isDisabled: boolean; onPr(): void; onExport(): void; onEvaluate(): void }
interface BodyProps { answer: ReportState; filter: ReportFilter; onFilter(filter: ReportFilter): void }

// N rodadas, then muted: the unpaired runs, the judge, and the yellow warning when the scores came from different rubrics
function Summary({ report }: { report: BenchReport }) {
  const { agent, model } = report.judge;
  const muted = [
    ...(report.unpaired.length > 0 ? [t('benchmark.report.unpaired', { runs: report.unpaired.join(', ') })] : []),
    t('benchmark.report.judgedBy', { judge: model === undefined ? agent : `${agent} · ${model}` }),
  ].join(' · ');
  return (
    <>
      <span>{tPlural('benchmark.report.rounds', report.rounds, { n: report.rounds })}</span>
      <span className="text-muted-foreground text-xs">{muted}{report.mixedRubrics && <span className="text-waiting"> {t('benchmark.report.mixedRubrics')}</span>}</span>
    </>
  );
}

function TopLine({ report, isDisabled, onPr, onExport, onEvaluate }: TopLineProps) {
  const action = (label: string, onClick: () => void) => <Button type="button" size="sm" variant="outline" disabled={isDisabled} onClick={onClick}>{label}</Button>;
  return (
    <div className="flex items-center gap-4 whitespace-nowrap text-[13px]">
      {report !== undefined && report.rounds > 0 && <Summary report={report} />}
      <span className="flex-1" />
      {action(t('benchmark.report.openPr'), onPr)}
      {action(t('benchmark.header.export'), onExport)}
      {action(t('benchmark.report.evaluate'), onEvaluate)}
    </div>
  );
}

// Shown only with an intervened run: with none, the filter changes nothing. K counts them out of the arms' eligible runs
function InterventionLine({ report, filter, onFilter }: { report: BenchReport; filter: ReportFilter; onFilter(filter: ReportFilter): void }) {
  const label = t('benchmark.report.intervened');
  const eligible = report.arms.reduce((sum, arm) => sum + arm.runs, 0);
  const runs = [
    t('benchmark.report.intervenedCount', { k: report.intervened.length, n: eligible }),
    ...report.intervened.map((r) => `${r.letter} ${r.token.slice(0, TOKEN_SHOWN)}`),
  ].join(' · ');
  return (
    <div className="flex items-center gap-2.5 text-muted-foreground text-xs">
      <span>{label}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the two filter buttons */}
      <span role="group" aria-label={label} className="flex rounded-md border bg-background p-0.5">
        {FILTERS.map((value) => (
          <button
            key={value} type="button" aria-pressed={value === filter} onClick={() => onFilter(value)}
            className={`rounded px-2.5 py-0.5 ${value === filter ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
          >
            {t(`benchmark.report.filter.${value}`)}
          </button>
        ))}
      </span>
      <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-1.5 rounded-full bg-waiting" />{runs}</span>
      <span>{t('benchmark.report.overrideNote')}</span>
    </div>
  );
}

// One sentence per slept round, then once what sleeping does to the measures
function SleepLine({ report }: { report: BenchReport }) {
  const rounds = report.sleeps.map((sleep) => t('benchmark.report.slept', {
    round: sleep.round, times: sleep.times, duration: formatDuration(sleep.ms), reasons: sleep.reasons.join('; '),
  }));
  return (
    <div className="-mt-1 flex items-center gap-2 text-muted-foreground text-xs">
      <MoonIcon aria-hidden="true" className="size-3 shrink-0" />
      <span>{[...rounds, t('benchmark.report.sleptNote')].join(' ')}</span>
    </div>
  );
}

function ReportBody({ answer, filter, onFilter }: BodyProps) {
  if (answer.state === 'loading') return null;
  if (answer.state === 'failed') return <p role="alert" className="text-destructive text-sm">{t('benchmark.report.failed.load')}</p>;
  const { report } = answer;
  if (report.rounds === 0) return <p className="text-[13px] text-muted-foreground">{t('benchmark.report.empty')}</p>;
  return (
    <>
      {report.intervened.length > 0 && <InterventionLine report={report} filter={filter} onFilter={onFilter} />}
      {report.sleeps.length > 0 && <SleepLine report={report} />}
      <ReportTable report={report} />
      <p className="text-muted-foreground text-xs">{t('benchmark.report.legend')}</p>
    </>
  );
}

// N is what POST …/evaluate takes; a refusal shows inline and keeps the dialog open, the new scores arrive through /events and the refetch
function EvaluateConfirm({ experiment, onClose }: { experiment: Experiment; onClose(): void }) {
  const [error, setError] = useState<string>();
  const runs = evaluableTokens(experiment).length;
  const confirm = async (): Promise<void> => {
    setError(undefined);
    try {
      await evaluateAgain(experiment.id);
    } catch (err) {
      setError(t(statusOf(err) === HTTP_CONFLICT ? 'benchmark.report.failed.busy' : 'benchmark.report.failed.evaluate'));
      throw err; // a rejected action keeps DialogBase open
    }
  };
  return (
    <Confirm
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('benchmark.report.evaluateTitle')}
      context={<span className="font-mono">{`${experiment.name} · ${tPlural('benchmark.report.runs', runs, { n: runs })}`}</span>}
      message={tPlural('benchmark.report.evaluateText', runs, { n: runs })} confirmLabel={t('benchmark.report.evaluateConfirm')} onConfirm={confirm} error={error}
    />
  );
}

/** The benchmark view's relatório (#467, benchmark.hv.html's #s-relatorio). Keyed by the experiment's id (tabs.ts), so another experiment
 *  starts back on entram na mediana; the two dialogs are mounted only while open. */
export function ReportTab({ experiment }: { experiment: Experiment }) {
  const [filter, setFilter] = useState<ReportFilter>('in');
  const [dialog, setDialog] = useState<'pr' | 'evaluate'>();
  const answer = useReport(experiment, filter);
  const report = answer.state === 'ready' ? answer.report : undefined;
  // Nothing to open, export or evaluate before a run entered; a failed read leaves them live, since none of them needs the report
  const isDisabled = answer.state === 'loading' || report?.rounds === 0;
  const close = (): void => setDialog(undefined);
  return (
    <div className="flex min-w-0 flex-col gap-3 px-6 py-5">
      <TopLine report={report} isDisabled={isDisabled} onPr={() => setDialog('pr')} onExport={() => void downloadReport(experiment)} onEvaluate={() => setDialog('evaluate')} />
      <ReportBody answer={answer} filter={filter} onFilter={setFilter} />
      {dialog === 'pr' && <BenchmarkPrDialog experiment={experiment} onClose={close} />}
      {dialog === 'evaluate' && <EvaluateConfirm experiment={experiment} onClose={close} />}
    </div>
  );
}
