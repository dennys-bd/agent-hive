import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { missingRuns } from '../../../../benchmark/scheduler.js';
import type { Experiment } from '../../../../types';
import { pairsText, runContext, runText } from '@/components/benchmark/execution/run-text';
import type { TabId } from '@/components/benchmark/tabs';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { moreRounds, refusalText, runExperiment, stopAfterRound } from '@/lib/benchmark-run-api';

interface ConfirmOf { experiment: Experiment; trigger: ReactElement }

/** Whether /run would take it (#472's rule, so no dead button): a draft, or a done experiment that still owes a run. */
export const canRun = (e: Experiment): boolean => e.status === 'draft' || (e.status === 'done' && missingRuns(e).length > 0);

// A refusal's line under the dialog's body; the rethrow keeps DialogBase open
function useRefusal() {
  const [error, setError] = useState<string>();
  const attempt = async (post: () => Promise<unknown>): Promise<void> => {
    setError(undefined);
    try {
      await post();
    } catch (err) {
      setError(refusalText(err));
      throw err;
    }
  };
  return { error, attempt, clear: () => setError(undefined) };
}

/** Executar experimento (dlg-run): the wording from the experiment; confirming posts /run. */
export function RunConfirm({ experiment, trigger }: ConfirmOf) {
  const refusal = useRefusal();
  return (
    <Confirm
      trigger={trigger} title={t('benchmark.execution.run.title')} context={runContext(experiment)} message={runText(experiment)}
      confirmLabel={t('benchmark.execution.action.run')} onConfirm={() => refusal.attempt(() => runExperiment(experiment.id))} error={refusal.error}
      onOpenChange={(open) => { if (!open) refusal.clear(); }}
    />
  );
}

const MIN_PAIRS = 1;

/** Executar mais rodadas: how many pairs, an integer ≥ 1, then /more-rounds { pairs }. The field starts at 1 on every open. */
export function MoreRoundsConfirm({ experiment, trigger }: ConfirmOf) {
  const [text, setText] = useState(String(MIN_PAIRS));
  const fieldId = useId(); // Biome does not see our Input as a control, so the label names it by id
  const refusal = useRefusal();
  const pairs = Number(text);
  const isValid = Number.isInteger(pairs) && pairs >= MIN_PAIRS;
  const message = (
    <span className="flex flex-col gap-2">
      <label htmlFor={fieldId} className="flex items-center gap-2">
        {t('benchmark.execution.more.pairs')}
        <Input id={fieldId} type="number" min={MIN_PAIRS} step={1} value={text} onChange={(event) => setText(event.target.value)} className="h-7 w-20" />
      </label>
      <span>{t('benchmark.execution.more.text', { pairs: pairsText(isValid ? pairs : 0) })}</span>
    </span>
  );
  return (
    <Confirm
      trigger={trigger} title={t('benchmark.execution.more.title')} context={experiment.name} message={message}
      confirmLabel={t('benchmark.execution.action.run')} disabled={!isValid} error={refusal.error}
      onConfirm={() => refusal.attempt(() => moreRounds(experiment.id, pairs))}
      onOpenChange={(open) => { if (!open) { setText(String(MIN_PAIRS)); refusal.clear(); } }}
    />
  );
}

// No dialog: the route only flags the experiment, and a second click is held off by the disabled label once the stream brings it
function StopButton({ experiment }: { experiment: Experiment }) {
  const isSet = experiment.stopAfterRound === true;
  const stop = async (): Promise<void> => {
    try {
      await stopAfterRound(experiment.id);
    } catch (err) {
      toast.error(refusalText(err));
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" disabled={isSet} onClick={() => void stop()} className="disabled:opacity-35">
      {t(isSet ? 'benchmark.execution.action.stopping' : 'benchmark.execution.action.stop')}
    </Button>
  );
}

const actionButton = (label: string): ReactElement => <Button type="button" size="sm" variant="outline">{label}</Button>;

/** The header's primary for a tab (#465, the screen's .act rules): executar on braços and comparar, parar após a rodada on execução,
 *  executar mais rodadas on relatório; none on config, and none at all while sleeping (2.8 owns acordar). */
export function primaryFor(tab: TabId, e: Experiment): ReactNode {
  if (e.status === 'sleeping') return null;
  if (tab === 'arms' || tab === 'compare') return canRun(e) ? <RunConfirm experiment={e} trigger={actionButton(t('benchmark.execution.action.run'))} /> : null;
  if (tab === 'execution') return e.status === 'running' ? <StopButton experiment={e} /> : null;
  if (tab === 'report' && (e.status === 'running' || e.status === 'done')) {
    return <MoreRoundsConfirm experiment={e} trigger={actionButton(t('benchmark.execution.action.more'))} />;
  }
  return null;
}
