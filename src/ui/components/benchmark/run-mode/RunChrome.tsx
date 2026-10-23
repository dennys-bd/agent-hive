import { ArrowLeftIcon, EyeIcon, FlaskConicalIcon } from 'lucide-react';
import { taskTotals } from '../../../../record-kit';
import type { State } from '../../../../types';
import { type RunHive, useRunHive } from '@/components/benchmark/run-mode/run-hive';
import { Button } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import { pendingSessions } from '@/lib/home';
import { compact, fmt } from '@/lib/usage';

export type RunState = 'frozen' | 'waiting' | 'running';
// The screen's two live chips and the ended run's (colour only for status): ok, wait, and done's muted border
const CHIP: Record<RunState, { key: MessageKey; className: string }> = {
  frozen: { key: 'benchmark.run.state.frozen', className: 'text-muted-foreground border-empty' },
  waiting: { key: 'benchmark.run.state.waiting', className: 'text-waiting' },
  running: { key: 'benchmark.run.state.running', className: 'text-working' },
};
const NO_DRAG = '[-webkit-app-region:no-drag]'; // the header drags the window; its own controls opt out, as Header.tsx's do

export const runStateOf = (run: RunHive, state: Pick<State, 'tasks' | 'workers' | 'activityRecords'>): RunState =>
  run.marker.frozen ? 'frozen' : pendingSessions(state).length > 0 ? 'waiting' : 'running';

/** The run's time and tokens (spec decision 9): since its first session began (an activity has no start of its own), and every task's tokens
 * as Detalhes and the activity bar count them (taskTotals). */
export function runMeta(state: State, now: number): string {
  const tokens = state.tasks.reduce((sum, task) => sum + taskTotals(state, task, now).tokens, 0);
  const starts = state.activityRecords.flatMap((record) => record.sessions.map((s) => Date.parse(s.startedAt)));
  const since = starts.length === 0 ? now : Math.min(...starts);
  return t('benchmark.run.meta', { time: compact(now - since), tokens: fmt(tokens) });
}

/** The header's brand slot in a run's Hive (#469): the flask and the run's token, in the ⬢'s place. */
export function RunBrand({ run }: { run: RunHive }) {
  return (
    <span className="flex items-center gap-1.5 font-semibold text-[13px]">
      <FlaskConicalIcon aria-hidden="true" className="size-[15px] text-muted-foreground" />{t('benchmark.run.brand', { token: run.marker.token })}
    </span>
  );
}

/** The header's centre in a run's Hive (#469): experiment › arm › par N, the state chip, time · tokens and voltar ao benchmark, which goes back
 * to the main daemon's page this window came from by one navigation; its view state reopens the benchmark view. */
export function RunHeader({ run, state }: { run: RunHive; state: State }) {
  const { experiment, arm, round } = run.marker;
  const look = CHIP[runStateOf(run, state)];
  return (
    <div data-run-header="" className="flex min-w-0 flex-1 items-center gap-2.5 px-3 text-[13px]">
      <nav aria-label={t('benchmark.run.crumbs')} className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <span className="text-muted-foreground">{experiment.name}</span>
        <span aria-hidden="true" className="text-muted-foreground">›</span>
        <span className="flex items-center gap-1.5">
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded bg-accent font-mono font-semibold text-[11px]">{arm.letter}</span>{arm.name}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">›</span>
        <span>{t('benchmark.run.pair', { round })}</span>
      </nav>
      <span data-testid="run-chip" className={`inline-flex items-center gap-1 rounded-lg border border-current px-1.5 text-[11px] whitespace-nowrap ${look.className}`}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{t(look.key)}
      </span>
      <span className="ml-auto whitespace-nowrap text-muted-foreground text-xs">{runMeta(state, Date.now())}</span>
      <Button type="button" variant="outline" size="sm" className={NO_DRAG} onClick={() => window.history.back()}>
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />{t('benchmark.run.back')}
      </Button>
    </div>
  );
}

/** The strip under the header (#469): what counts as an intervention, and the count GET /benchmark-run answers. */
export function RunBand() {
  const run = useRunHive();
  if (run === undefined) return null;
  return (
    <div role="note" className="flex shrink-0 items-center gap-2.5 border-b bg-muted px-4 py-[7px] text-muted-foreground text-xs">
      <EyeIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="flex-1">{t('benchmark.run.band')}</span>
      <span className="shrink-0">{t('benchmark.run.count', { n: run.interventions.length })}</span>
    </div>
  );
}

/** The footer's content in a run's Hive (#469): the isolated home, the local origin, the one environment there is, the arm's pair. */
export function RunFooter({ run }: { run: RunHive }) {
  const { arm, round, pairs } = run.marker;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden whitespace-nowrap">
      <span>{t('benchmark.run.home', { home: run.home })}</span>
      <span>{t('benchmark.run.origin')}</span>
      <span>{t('benchmark.run.environment')}</span>
      <span className="ml-auto">{t('benchmark.run.arm', { letter: arm.letter, round, pairs })}</span>
    </div>
  );
}
