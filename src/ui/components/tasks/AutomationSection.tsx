import type { ReactNode } from 'react';
import { SignalToggle } from '@/components/SignalToggle';
import { WorkerCap } from '@/components/WorkerCap';
import { controlLabel, NEW_TASKS_LABEL, NEW_TASKS_OPTIONS, STARTED_LABEL, STARTED_OPTIONS } from '@/components/settings/SignalCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSignalEdit } from '@/hooks/use-signals';
import { t } from '@/i18n';
import { behaviourOf, isRefused } from '../../../signals.js';
import type { EffectiveLimits, NewTasks, Signal, SignalBehaviour, SignalSettings, StartedBehaviour, State } from '../../../types.js';

interface AutomationSectionProps { state: State; effective?: EffectiveLimits }
interface ControlProps { signals: SignalSettings; signal: Signal; edit(patch: Partial<SignalBehaviour>): void }

// The handoff's compact select (.sig-sel): 24px, bordered, on the page background; the trigger's sm size is 32px, so its height is overridden
const SELECT = 'gap-1 bg-background px-2 text-xs data-[size=sm]:h-6 dark:bg-background';
const FIXED = 'flex-none text-xs';

// A row (.sig-row): the muted label takes the width, the control sits on the right; the tooltip is the Settings hint, which the 220px cannot show
function Row({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs" title={title}>
      <span className="min-w-0 flex-1 text-muted-foreground leading-[15px]">{label}</span>
      {children}
    </div>
  );
}

function NewTasksSelect({ signals, signal, edit }: ControlProps) {
  return (
    <Select value={behaviourOf(signal, signals).newTasks} onValueChange={(v) => edit({ newTasks: v as NewTasks })}>
      <SelectTrigger size="sm" aria-label={t('settings.signal.newTasks.control', { signal })} className={SELECT}><SelectValue /></SelectTrigger>
      <SelectContent>
        {NEW_TASKS_OPTIONS.map((o) => <SelectItem key={o} value={o} disabled={isRefused(signals, signal, { newTasks: o })}>{t(NEW_TASKS_LABEL[o])}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// Green's started is fixed (behaviourOf), so it is text, as in the Settings card
function StartedControl({ signals, signal, edit }: ControlProps) {
  if (signal === 'green') return <span className={FIXED}>{t(STARTED_LABEL.resumeAndContinue)}</span>;
  return (
    <Select value={signals[signal].started} onValueChange={(v) => edit({ started: v as StartedBehaviour })}>
      <SelectTrigger size="sm" aria-label={controlLabel('started', signal)} className={SELECT}><SelectValue /></SelectTrigger>
      <SelectContent>
        {STARTED_OPTIONS.map((o) => <SelectItem key={o} value={o} disabled={isRefused(signals, signal, { started: o })}>{t(STARTED_LABEL[o])}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function WorkerlessControl({ signals, signal, edit }: ControlProps) {
  if (signal === 'green') return <span className={FIXED}>{t('settings.signal.always')}</span>;
  const value = signals[signal].workerless;
  return (
    <Switch
      aria-label={controlLabel('workerless', signal)} checked={value} disabled={isRefused(signals, signal, { workerless: !value })}
      onCheckedChange={(checked) => edit({ workerless: checked })}
    />
  );
}

// Only the active signal's rows (handoff §4a). They render state.signals, never a local copy: the save is not optimistic (spec decision 7)
function SignalRows({ signals, signal }: { signals: SignalSettings; signal: Signal }) {
  const editSignals = useSignalEdit();
  const props: ControlProps = { signals, signal, edit: (patch) => editSignals(signals, signal, patch) };
  return (
    <div className="flex flex-col gap-2 px-0.5 pt-0.5">
      <Row label={t('settings.signal.newTasks')} title={`${t('settings.signal.newTasks.hint')} · ${t('settings.signal.newTasks.treeHint')}`}><NewTasksSelect {...props} /></Row>
      <Row label={t('settings.signal.started')} title={t('settings.signal.started.hint')}><StartedControl {...props} /></Row>
      <Row label={t('tasks.automation.workerless')} title={t('settings.signal.workerless.hint')}><WorkerlessControl {...props} /></Row>
    </div>
  );
}

/** The tasks sidebar's automação (#573, handoff §4a): the signal's segmented control, the active signal's three rows, saved to
 * hive.config.json from here, and the workers line with the editable cap at the foot. */
export function AutomationSection({ state, effective }: AutomationSectionProps) {
  return (
    <div className="flex flex-col gap-[18px] py-1">
      <div className="flex flex-col gap-2">
        <SignalToggle signal={state.signal} effective={effective} />
        <SignalRows signals={state.signals} signal={state.signal} />
      </div>
      <WorkerCap state={state} effective={effective} />
    </div>
  );
}
