import { ArrowLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { Experiment } from '../../../../types';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { elapsedMs, hoursMinutes, type RoundRow, roundRows, type RunCardRow } from '@/components/benchmark/execution/execution-rows';
import { RunCard } from '@/components/benchmark/execution/RunCard';
import { roundOf } from '@/components/benchmark/sidebar-groups';
import { useTick } from '@/hooks/use-tick';
import { t } from '@/i18n';
import { goToRunHive, openRunHive } from '@/lib/benchmark-run-api';

export interface ExecutionTabProps { experiment: Experiment; benchmark: Benchmark; result?(experiment: Experiment, token: string): ReactNode }

const isLive = (e: Experiment): boolean => e.status === 'running' || e.status === 'sleeping';

function TopLine({ experiment, now }: { experiment: Experiment; now: number }) {
  const elapsed = isLive(experiment) ? elapsedMs(experiment, now) : undefined;
  const label = (text: string): ReactNode => <span className="text-muted-foreground">{`${text} `}</span>;
  return (
    <div className="flex items-center gap-6 text-[13px]">
      <span>{label(t('benchmark.execution.top.round'))}{t('benchmark.execution.top.of', roundOf(experiment))}</span>
      {experiment.pace.until !== undefined && <span>{label(t('benchmark.execution.top.next'))}{experiment.pace.until}</span>}
      {elapsed !== undefined && <span>{label(t('benchmark.execution.top.running'))}{hoursMinutes(elapsed)}</span>}
      <span className="ml-auto text-muted-foreground text-xs">{t('benchmark.execution.top.blind')}</span>
    </div>
  );
}

function Round({ row, onAction }: { row: RoundRow; onAction(card: RunCardRow): void }) {
  const name = t('benchmark.execution.round', { n: row.n });
  return (
    <section aria-label={name} className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5 text-muted-foreground text-xs"><b className="font-semibold text-[13px] text-foreground">{name}</b><span>{row.sub}</span></div>
      <div className={`grid grid-cols-4 gap-3 ${row.kind === 'queued' ? 'opacity-55' : ''}`}>
        {row.cards.map((card) => <RunCard key={card.key} card={card} onAction={onAction} />)}
      </div>
    </section>
  );
}

// The result screen's back line; 2.6 fills the body through the tab's `result`
function ResultSlot({ experiment, token, benchmark, result }: ExecutionTabProps & { token: string }) {
  return (
    <div className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-1.5 text-[13px]">
        <button type="button" onClick={() => benchmark.closeResult()} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />{t('benchmark.header.tab.execution')}
        </button>
        <span aria-hidden="true" className="text-muted-foreground">›</span>
      </div>
      {result?.(experiment, token) ?? <p className="text-muted-foreground text-sm">{t('benchmark.header.soon')}</p>}
    </div>
  );
}

// The run's Hive replaces this window; a refusal (not started, unreachable, a frozen daemon that did not boot) is a toast: there is no dialog
async function openHive(id: string, token: string): Promise<void> {
  try {
    goToRunHive((await openRunHive(id, token)).port);
  } catch {
    toast.error(t('benchmark.execution.failed.open'));
  }
}

/** The execução tab (#465, benchmark.hv.html's #s-execucao): the top line and the round bands, or the picked run's result slot. */
export function ExecutionTab({ experiment, benchmark, result }: ExecutionTabProps) {
  const token = benchmark.run;
  useTick(token === undefined && isLive(experiment)); // the cards' clocks and em execução há move
  if (token !== undefined) return <ResultSlot experiment={experiment} token={token} benchmark={benchmark} result={result} />;
  const now = Date.now();
  const act = (card: RunCardRow): void => {
    if (card.token === undefined) return;
    if (card.action === 'result') benchmark.openResult(card.token);
    else void openHive(experiment.id, card.token);
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <TopLine experiment={experiment} now={now} />
      {roundRows(experiment, now).map((row) => <Round key={row.n} row={row} onAction={act} />)}
    </div>
  );
}
