import { useId, useRef, useState } from 'react';
import { failedText } from '@/components/benchmark/failed';
import { roundOf } from '@/components/benchmark/sidebar-groups';
import {
  controlPath, isDeadlinePassed, isTime, openSleep, sleepingRuns, sleptMs, spanText, tasksInProgress, wakeBody, type WakeChoice,
} from '@/components/benchmark/sleep/sleep-model';
import { DialogBase } from '@/components/DialogBase';
import { Input } from '@/components/ui/input';
import { t, tPlural } from '@/i18n';
import { sendJson } from '@/lib/api';
import { clockOf } from '@/lib/design-comments';
import type { Experiment } from '../../../../types.js';

interface WakeDialogProps { experiment: Experiment; onClose(): void }
interface OptionProps { name: string; value: WakeChoice; choice: WakeChoice; title: string; hint: string; onPick(value: WakeChoice): void }
interface DeadlineProps { experiment: Experiment; choice: WakeChoice; until: string; onChoice(choice: WakeChoice): void; onUntil(until: string): void }

function Option({ name, value, choice, title, hint, onPick }: OptionProps) {
  return (
    <label className="flex flex-1 items-start gap-2">
      <input type="radio" name={name} className="mt-1 accent-primary" checked={choice === value} onChange={() => onPick(value)} />
      <span className="flex flex-col"><span className="font-medium">{title}</span><span className="text-muted-foreground text-xs">{hint}</span></span>
    </label>
  );
}

// The yellow notice and the three deadline options, shown only when the deadline passed while asleep. N is the chip's round
function DeadlineOptions({ experiment, choice, until, onChoice, onUntil }: DeadlineProps) {
  const name = useId();
  const field = useRef<HTMLInputElement>(null);
  const { n, m } = roundOf(experiment);
  const deadline = experiment.pace.until ?? '';
  // On the last round no next one was owed, so the notice names none
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="flex items-center gap-2 text-waiting">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />{n >= m ? t('benchmark.sleep.passedLast', { until: deadline }) : t('benchmark.sleep.passed', { until: deadline, next: n + 1 })}
      </p>
      <div role="radiogroup" aria-label={t('benchmark.sleep.deadline')} className="flex flex-col gap-2">
        <Option name={name} value="finish-round" choice={choice} title={t('benchmark.sleep.finishRound', { n })} hint={t('benchmark.sleep.finishRoundHint')} onPick={onChoice} />
        <div className="flex items-start gap-2">
          <Option
            name={name} value="until" choice={choice} title={t('benchmark.sleep.newUntil')} hint={t('benchmark.sleep.newUntilHint', { n })}
            onPick={(value) => { onChoice(value); field.current?.focus(); }}
          />
          <Input
            ref={field} type="time" aria-label={t('benchmark.sleep.untilLabel')} value={until} className="h-7 w-28"
            onFocus={() => onChoice('until')} onChange={(e) => onUntil(e.target.value)}
          />
        </div>
        <Option name={name} value="none" choice={choice} title={t('benchmark.sleep.noLimit')} hint={t('benchmark.sleep.noLimitHint')} onPick={onChoice} />
      </div>
    </div>
  );
}

function contextOf(experiment: Experiment): string | undefined {
  const sleep = openSleep(experiment);
  if (sleep === undefined) return undefined;
  const runs = sleepingRuns(experiment);
  return t('benchmark.sleep.wakeContext', { time: clockOf(new Date(sleep.at)), reason: sleep.reason, runs: runs.length, tasks: tasksInProgress(runs) });
}

/** dlg-wake (#468): when and why it slept and what continues; past the deadline, the notice and the three options. Posting /wake (202)
 *  closes it; continuar dormindo closes with no post. */
export function WakeDialog({ experiment, onClose }: WakeDialogProps) {
  const [now] = useState(() => new Date()); // the moment it opened: the notice must not appear under the user's cursor
  const [choice, setChoice] = useState<WakeChoice>('finish-round');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string>();
  const isPassed = isDeadlinePassed(experiment, now);
  const canWake = !isPassed || choice !== 'until' || isTime(until);
  const count = experiment.sleeps.length;
  const wake = async (): Promise<void> => {
    setError(undefined);
    try {
      await sendJson('POST', controlPath(experiment.id, 'wake'), wakeBody(isPassed, choice, until));
    } catch (err) {
      setError(failedText(err));
      throw err; // a rejected action keeps DialogBase open, the reason shown inline
    }
  };
  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('benchmark.sleep.wakeTitle')} context={contextOf(experiment)}
      cancelLabel={t('benchmark.sleep.keepSleeping')} primary={{ label: t('benchmark.sleep.wake'), onConfirm: wake, disabled: !canWake }} error={error}
    >
      {isPassed && <DeadlineOptions experiment={experiment} choice={choice} until={until} onChoice={setChoice} onUntil={setUntil} />}
      <p className="text-muted-foreground text-xs">{tPlural('benchmark.sleep.slept', count, { n: count, span: spanText(sleptMs(experiment, now)) })}</p>
    </DialogBase>
  );
}
