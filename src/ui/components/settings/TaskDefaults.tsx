import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EntrySelect } from '@/components/settings/EntrySelect';
import { t } from '@/i18n';
import { type FlowScope, PROP_LABEL, PROP_NOTE, type PropMode, propMode, type PropValue, type SourceTaskPropsDraft, withProp } from '@/lib/setup-source-task-props';
import { TASK_PROPS, type TaskProp } from '../../../types';

const NONE = '__none__'; // Radix Select rejects value=""; '' (no workspace) travels as this
const YES = 'yes';
const NO = 'no';
const MUTED = 'text-muted-foreground text-xs';
/** A part's heading inside the task properties group (#688), as a stage block's (`1 · entra`). */
export const PART_TITLE = 'font-semibold text-muted-foreground text-xs uppercase tracking-widest';

interface PropSelectProps { id?: string; prop: TaskProp; value: string | boolean; workspaces: string[]; allowNone?: boolean; small?: boolean; label?: string; onChange(value: string | boolean): void }

const asText = (value: string | boolean): string => (typeof value === 'boolean' ? (value ? YES : NO) : value || NONE);

/** One property's value (#688): a Comb workspace (and no workspace where allowed), or auto's yes / no. The defaults and the rule chips share it. */
export function PropSelect({ id, prop, value, workspaces, allowNone = false, small = false, label, onChange }: PropSelectProps) {
  const pick = (text: string): void => onChange(prop === 'auto' ? text === YES : text === NONE ? '' : text);
  const options = prop === 'auto' ? [YES, NO] : [...(allowNone ? [NONE] : []), ...workspaces];
  const optionText = (v: string): string => {
    if (prop === 'auto' && v === YES) return t('settings.taskProps.yes');
    if (v === NO && prop === 'auto') return t('settings.taskProps.no');
    return v === NONE ? t('settings.taskProps.noWorkspace') : v;
  };
  return (
    <Select value={asText(value)} onValueChange={pick}>
      <SelectTrigger id={id} aria-label={label} size={small ? 'sm' : 'default'} className={small ? undefined : 'w-full'}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((v) => <SelectItem key={v} value={v}>{optionText(v)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

interface PropControlProps extends Omit<PropSelectProps, 'value' | 'onChange'> { value: PropValue; scope: FlowScope; onChange(value: PropValue): void }

/** One property's control (#670): entry has its own menu (EntrySelect); workspace and auto PropSelect. The defaults row and a rule's chip share it. */
export function PropControl({ scope, value, onChange, ...rest }: PropControlProps) {
  if (rest.prop === 'entry') return value === undefined || typeof value === 'string' || typeof value === 'boolean' ? null : <EntrySelect id={rest.id} value={value} scope={scope} small={rest.small} label={rest.label} onChange={onChange} />;
  return typeof value === 'object' ? null : <PropSelect {...rest} value={value} onChange={onChange} />;
}

const modeText = (mode: PropMode): string =>
  mode === 'fixed' ? t('settings.taskProps.mode.fixed') : t(mode === 1 ? 'settings.taskProps.mode.one' : 'settings.taskProps.mode.other', { n: mode });

interface TaskDefaultsProps { id: string; scope: FlowScope; draft: SourceTaskPropsDraft; workspaces: string[]; onChange(draft: SourceTaskPropsDraft): void }

/** The default part (#688): one row per property in registry order, its default and its derived mode. A property no rule sets is fixed. */
export function TaskDefaults({ id, scope, draft, workspaces, onChange }: TaskDefaultsProps) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className={PART_TITLE}>{t('settings.taskProps.defaults')}</h3>
      <div data-testid="task-defaults" className="rounded-md border">
        {TASK_PROPS.map((prop) => (
          <div key={prop} data-testid="task-default-row" className="grid grid-cols-[8rem_16rem_minmax(0,1fr)] items-center gap-4 border-b px-3 py-2 last:border-b-0">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${id}-${prop}`}>{t(PROP_LABEL[prop])}</Label>
              <span className={MUTED}>{t(PROP_NOTE[prop])}</span>
            </div>
            <PropControl
              id={`${id}-${prop}`} prop={prop} value={draft.defaults[prop]} scope={scope} workspaces={workspaces} allowNone label={t(PROP_LABEL[prop])}
              onChange={(value) => onChange({ ...draft, defaults: withProp(draft.defaults, prop, value) })}
            />
            <span className={MUTED}>{modeText(propMode(draft, prop))}</span>
          </div>
        ))}
      </div>
      <p className={MUTED}>{t('settings.taskProps.defaultsHint')}</p>
      <p className={MUTED}>{t('settings.taskProps.entry.hint')}</p>
    </div>
  );
}
