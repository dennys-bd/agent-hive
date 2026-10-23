import { useId, useState } from 'react';
import { failedText } from '@/components/benchmark/failed';
import { controlPath, isTime, MAX_REASON, runsToSleep, sleepBody, tasksInProgress } from '@/components/benchmark/sleep/sleep-model';
import { DialogBase } from '@/components/DialogBase';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import { sendJson } from '@/lib/api';
import { TOKEN_SHOWN } from '@/lib/benchmark-pr';
import type { BenchRun, Experiment } from '../../../../types.js';

type WakeMode = 'asked' | 'at';
interface SleepDialogProps { experiment: Experiment; onClose(): void }
interface WakeAtProps { name: string; mode: WakeMode; wakeAt: string; onMode(mode: WakeMode): void; onWakeAt(value: string): void }

const KEY = 'text-muted-foreground';
const PILL = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs';

const pillOf = (e: Experiment, r: BenchRun): string => t('benchmark.sleep.pill', {
  letter: e.arms.find((a) => a.id === r.armId)?.letter ?? '', token: r.token.slice(0, TOKEN_SHOWN), delivered: r.delivered, total: r.total,
});

// quando eu mandar, or às… with the native time field, which gives the route's HH:MM
function WakeAtField({ name, mode, wakeAt, onMode, onWakeAt }: WakeAtProps) {
  const option = (value: WakeMode, label: string) => (
    <label className="flex items-center gap-1.5">
      <input type="radio" name={name} className="accent-primary" checked={mode === value} onChange={() => onMode(value)} />{label}
    </label>
  );
  return (
    <div role="radiogroup" aria-label={t('benchmark.sleep.wake')} className="flex flex-wrap items-center gap-3">
      {option('asked', t('benchmark.sleep.whenAsked'))}
      {option('at', t('benchmark.sleep.at'))}
      {mode === 'at' && <Input type="time" aria-label={t('benchmark.sleep.atLabel')} value={wakeAt} onChange={(e) => onWakeAt(e.target.value)} className="h-7 w-28" />}
    </div>
  );
}

/** dlg-sleep (#468): the runs that will sleep with their point, the tasks left in progress, the required reason and when to wake. Posting
 *  /sleep closes it; the /events stream brings the sleeping status, so nothing is set here. */
export function SleepDialog({ experiment, onClose }: SleepDialogProps) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<WakeMode>('asked');
  const [wakeAt, setWakeAt] = useState('');
  const [error, setError] = useState<string>();
  const runs = runsToSleep(experiment);
  const inProgress = tasksInProgress(runs);
  const canSleep = reason.trim() !== '' && (mode === 'asked' || isTime(wakeAt));
  const sleep = async (): Promise<void> => {
    setError(undefined);
    try {
      await sendJson('POST', controlPath(experiment.id, 'sleep'), sleepBody(reason, mode === 'at' ? wakeAt : undefined));
    } catch (err) {
      setError(failedText(err));
      throw err; // a rejected action keeps DialogBase open, the reason shown inline
    }
  };
  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('benchmark.sleep.title')} context={t('benchmark.sleep.lead')}
      primary={{ label: t('benchmark.sleep.confirm'), onConfirm: sleep, disabled: !canSleep }} error={error}
    >
      <div className="flex flex-col gap-4 text-[13px]">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
          <span className={KEY}>{t('benchmark.sleep.willSleep')}</span>
          <span className="flex flex-wrap gap-1.5">{runs.map((r) => <span key={r.token} className={PILL}>{pillOf(experiment, r)}</span>)}</span>
          {inProgress > 0 && <><span className={KEY}>{t('benchmark.sleep.tasks')}</span><span className={KEY}>{t('benchmark.sleep.tasksLine', { n: inProgress })}</span></>}
          <Label htmlFor={`${id}-reason`} className={KEY}>{t('benchmark.sleep.reason')}</Label>
          <Input id={`${id}-reason`} value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />
          <span className={KEY}>{t('benchmark.sleep.wake')}</span>
          <WakeAtField name={`${id}-wake`} mode={mode} wakeAt={wakeAt} onMode={setMode} onWakeAt={setWakeAt} />
        </div>
        <p className="text-muted-foreground text-xs">{t('benchmark.sleep.note')}</p>
      </div>
    </DialogBase>
  );
}
