import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';
import { behaviourOf, clamped, isOrdered } from '../../../signals';
import {
  NEW_TASKS, SIGNAL_ON_OPEN, STARTED_BEHAVIOURS, type NewTasks, type RuleSignal, type Signal, type SignalBehaviour, type SignalOnOpen,
  type SignalSettings, type StartedBehaviour,
} from '../../../types';

interface SignalCardProps { signals: SignalSettings; onChange(signals: SignalSettings): void }
type Row = 'newTasks' | 'started' | 'workerless';

// The handoff's table (Configuracao.dc.html, screen 06): the row's label, then green, yellow and red
const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(3,10rem)] items-center gap-3 px-3 py-2';
const PILLS = ['green', 'yellow', 'red'] as const;
const STARTED_LABEL: Record<StartedBehaviour, MessageKey> = {
  resumeAndContinue: 'settings.signal.started.resumeAndContinue', continueOnly: 'settings.signal.started.continueOnly', stay: 'settings.signal.started.stay',
};
const NEW_TASKS_LABEL: Record<NewTasks, MessageKey> = {
  always: 'settings.signal.newTasks.always', tree: 'settings.signal.newTasks.tree', never: 'settings.signal.newTasks.never',
};
// Both menus read loosest first, as the green column does
const STARTED_OPTIONS = [...STARTED_BEHAVIOURS].reverse();
const NEW_TASKS_OPTIONS = [...NEW_TASKS].reverse();

// One signal's row patched (#727, #32); each stricter row is clamped down to the one above it, so a looser edit keeps green ≥ yellow ≥ red
function patched(signals: SignalSettings, signal: Signal, patch: Partial<SignalBehaviour>): SignalSettings {
  const green = signal === 'green' ? { newTasks: patch.newTasks ?? signals.green.newTasks } : signals.green;
  const yellow = signal === 'yellow' ? { ...signals.yellow, ...patch } : clamped(behaviourOf('green', { ...signals, green }), signals.yellow);
  const red = signal === 'red' ? { ...signals.red, ...patch } : clamped(yellow, signals.red);
  return { ...signals, green, yellow, red };
}

// A value the order would refuse: its control is disabled, as parseConfig would refuse the save. Only an edit can break the order against the
// signal above it; the ones below are clamped
const refused = (signals: SignalSettings, signal: Signal, patch: Partial<SignalBehaviour>): boolean => !isOrdered(patched(signals, signal, patch));

const controlLabel = (row: Exclude<Row, 'newTasks'>, signal: RuleSignal): string => t('settings.signal.control', { row: t(`settings.signal.${row}`), signal });

interface CellProps { signals: SignalSettings; signal: RuleSignal; onChange(signals: SignalSettings): void }

function WorkerlessSwitch({ signals, signal, onChange }: CellProps) {
  const value = signals[signal].workerless;
  return (
    <Switch
      aria-label={controlLabel('workerless', signal)} checked={value} disabled={refused(signals, signal, { workerless: !value })}
      onCheckedChange={(checked) => onChange(patched(signals, signal, { workerless: checked }))}
    />
  );
}

function NewTasksSelect({ signals, signal, onChange }: Omit<CellProps, 'signal'> & { signal: Signal }) {
  return (
    <Select value={behaviourOf(signal, signals).newTasks} onValueChange={(v) => onChange(patched(signals, signal, { newTasks: v as NewTasks }))}>
      <SelectTrigger size="sm" aria-label={t('settings.signal.newTasks.control', { signal })} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {NEW_TASKS_OPTIONS.map((o) => <SelectItem key={o} value={o} disabled={refused(signals, signal, { newTasks: o })}>{t(NEW_TASKS_LABEL[o])}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function StartedSelect({ signals, signal, onChange }: CellProps) {
  return (
    <Select value={signals[signal].started} onValueChange={(v) => onChange(patched(signals, signal, { started: v as StartedBehaviour }))}>
      <SelectTrigger size="sm" aria-label={controlLabel('started', signal)} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {STARTED_OPTIONS.map((o) => <SelectItem key={o} value={o} disabled={refused(signals, signal, { started: o })}>{t(STARTED_LABEL[o])}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function RowLabel({ row, more }: { row: Row; more?: MessageKey }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm">{t(`settings.signal.${row}`)}</span>
      <span className="text-muted-foreground text-xs">{t(`settings.signal.${row}.hint`)}</span>
      {more && <span className="text-muted-foreground text-xs">{t(more)}</span>}
    </div>
  );
}

// The three behaviours: green's new tasks are the user's (#32), its other rows fixed muted text; yellow and red are the user's
function BehaviourTable({ signals, onChange }: SignalCardProps) {
  const cell = { signals, onChange };
  return (
    <div className="flex flex-col rounded-md border">
      <div className={`${GRID} border-b text-muted-foreground text-xs`}>
        <span>{t('settings.signal.column')}</span>
        {PILLS.map((s) => <span key={s} data-signal={s} className="signal-pill justify-self-start rounded-sm px-2 py-px font-medium">{s}</span>)}
      </div>
      <div className={`${GRID} border-b`}>
        <RowLabel row="newTasks" more="settings.signal.newTasks.treeHint" />
        {PILLS.map((s) => <NewTasksSelect key={s} {...cell} signal={s} />)}
      </div>
      <div className={`${GRID} border-b`}>
        <RowLabel row="started" />
        <span className="text-muted-foreground text-xs">{t(STARTED_LABEL.resumeAndContinue)}</span>
        <StartedSelect {...cell} signal="yellow" />
        <StartedSelect {...cell} signal="red" />
      </div>
      <div className={GRID}>
        <RowLabel row="workerless" />
        <span className="text-muted-foreground text-xs">{t('settings.signal.always')}</span>
        <WorkerlessSwitch {...cell} signal="yellow" />
        <WorkerlessSwitch {...cell} signal="red" />
      </div>
    </div>
  );
}

/** Settings › rules' signal card (#727): what each signal lets the Hive do on its own, the signal a boot opens on, and the footnote. Saved
 * with the rest of Settings. */
export function SignalCard({ signals, onChange }: SignalCardProps) {
  return (
    <SettingsGroup title="settings.signal.title" hint="settings.signal.description">
      <BehaviourTable signals={signals} onChange={onChange} />
      <div id={settingAnchor('settings.signal.onOpen')} className="flex max-w-[22rem] flex-col gap-1">
        <Label htmlFor="settings-signal-on-open">{t('settings.signal.onOpen')}</Label>
        <Select value={signals.onOpen} onValueChange={(v) => onChange({ ...signals, onOpen: v as SignalOnOpen })}>
          <SelectTrigger id="settings-signal-on-open" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SIGNAL_ON_OPEN.map((o) => <SelectItem key={o} value={o}>{o === 'last' ? t('settings.signal.onOpen.last') : o}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-xs">{t('settings.signal.onOpen.hint')}</span>
      </div>
      <p className="text-muted-foreground text-xs">{t('settings.signal.footnote')}</p>
    </SettingsGroup>
  );
}
