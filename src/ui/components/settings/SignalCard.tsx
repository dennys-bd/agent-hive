import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import { clampedRed, isOrdered } from '../../../signals';
import { SIGNAL_ON_OPEN, STARTED_BEHAVIOURS, type RuleSignal, type SignalBehaviour, type SignalOnOpen, type SignalSettings, type StartedBehaviour } from '../../../types';

interface SignalCardProps { signals: SignalSettings; onChange(signals: SignalSettings): void }
type Flag = 'newTasks' | 'workerless';
type Row = Flag | 'started';

// The handoff's table (Configuracao.dc.html, screen 06): the row's label, then green, yellow and red
const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(3,10rem)] items-center gap-3 px-3 py-2';
const PILLS = ['green', 'yellow', 'red'] as const;
const STARTED_LABEL: Record<StartedBehaviour, MessageKey> = {
  resumeAndContinue: 'settings.signal.started.resumeAndContinue', continueOnly: 'settings.signal.started.continueOnly', stay: 'settings.signal.started.stay',
};
const STARTED_OPTIONS = [...STARTED_BEHAVIOURS].reverse(); // the menu reads loosest first, as the green column does

const flag = (row: Flag, value: boolean): Partial<SignalBehaviour> => (row === 'newTasks' ? { newTasks: value } : { workerless: value });

// One row of yellow or red patched; a yellow edit pulls red down so the pair stays ordered (isOrdered)
function patched(signals: SignalSettings, signal: RuleSignal, patch: Partial<SignalBehaviour>): SignalSettings {
  if (signal === 'red') return { ...signals, red: { ...signals.red, ...patch } };
  const yellow = { ...signals.yellow, ...patch };
  return { ...signals, yellow, red: clampedRed(yellow, signals.red) };
}

// A red value the order would refuse: its control is disabled, as parseConfig would refuse the save
const refused = (signals: SignalSettings, signal: RuleSignal, patch: Partial<SignalBehaviour>): boolean =>
  signal === 'red' && !isOrdered(patched(signals, 'red', patch));

const controlLabel = (row: Row, signal: RuleSignal): string => t('settings.signal.control', { row: t(`settings.signal.${row}`), signal });

interface CellProps { signals: SignalSettings; signal: RuleSignal; onChange(signals: SignalSettings): void }

function FlagSwitch({ signals, signal, row, onChange }: CellProps & { row: Flag }) {
  const value = signals[signal][row];
  return (
    <Switch
      aria-label={controlLabel(row, signal)} checked={value} disabled={refused(signals, signal, flag(row, !value))}
      onCheckedChange={(checked) => onChange(patched(signals, signal, flag(row, checked)))}
    />
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

function RowLabel({ row }: { row: Row }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm">{t(`settings.signal.${row}`)}</span>
      <span className="text-muted-foreground text-xs">{t(`settings.signal.${row}.hint`)}</span>
    </div>
  );
}

// The three behaviours: green is fixed muted text, yellow and red are the user's
function BehaviourTable({ signals, onChange }: SignalCardProps) {
  const cell = { signals, onChange };
  return (
    <div className="flex flex-col rounded-md border">
      <div className={`${GRID} border-b text-muted-foreground text-xs`}>
        <span>{t('settings.signal.column')}</span>
        {PILLS.map((s) => <span key={s} data-signal={s} className="signal-pill justify-self-start rounded-sm px-2 py-px font-medium">{s}</span>)}
      </div>
      <div className={`${GRID} border-b`}>
        <RowLabel row="newTasks" />
        <span className="text-muted-foreground text-xs">{t('settings.signal.always')}</span>
        <FlagSwitch {...cell} signal="yellow" row="newTasks" />
        <FlagSwitch {...cell} signal="red" row="newTasks" />
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
        <FlagSwitch {...cell} signal="yellow" row="workerless" />
        <FlagSwitch {...cell} signal="red" row="workerless" />
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
      <div className="flex max-w-[22rem] flex-col gap-1">
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
