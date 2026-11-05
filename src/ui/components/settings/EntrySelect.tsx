import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { type EntryDraft, entryGone, entryLabel, type FlowScope } from '@/lib/setup-source-task-props';

const OUTSIDE = '__outside__'; // Radix Select rejects value=""; null (outside the flow) travels as this
const MUTED = 'text-muted-foreground text-xs';

interface EntrySelectProps { id?: string; value: EntryDraft; scope: FlowScope; small?: boolean; label?: string; onChange(value: EntryDraft): void }

const keyOf = (value: EntryDraft): string => (value === null ? OUTSIDE : value.stageId === undefined ? `flow:${value.flowId}` : `stage:${value.stageId}`);

/** The entry property's value (#670, handoff): outside the flow, then per flow a group headed by its name: the flow (its first stage), then its other
 * stages, indented; flow and stage are one value. The defaults row and a rule's chip share it. */
export function EntrySelect({ id, value, scope, small = false, label, onChange }: EntrySelectProps) {
  const groups = scope.flows.map((flow) => ({ flow, stages: scope.stages.filter((s) => s.flow === flow.id) }));
  // Looked up by option value, so a pick never parses an id back out of a string.
  const values = new Map<string, EntryDraft>([
    [OUTSIDE, null],
    ...groups.flatMap(({ flow, stages }): [string, EntryDraft][] => [
      [`flow:${flow.id}`, { flowId: flow.id }],
      ...stages.slice(1).map((s): [string, EntryDraft] => [`stage:${s.id}`, { flowId: flow.id, stageId: s.id }]),
    ]),
  ]);
  const pick = (key: string): void => {
    const picked = values.get(key);
    if (picked !== undefined) onChange(picked);
  };
  return (
    <Select value={keyOf(value)} onValueChange={pick}>
      <SelectTrigger id={id} aria-label={label} aria-invalid={entryGone(value, scope)} size={small ? 'sm' : 'default'} className={small ? undefined : 'w-full'}>
        <SelectValue>{entryLabel(value, scope)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={OUTSIDE}>{t('start.destination.none')}</SelectItem>
        {groups.map(({ flow, stages }) => (
          <SelectGroup key={flow.id}>
            <SelectLabel>{flow.name.trim()}</SelectLabel>
            <SelectItem value={`flow:${flow.id}`}>
              {flow.name.trim()} <span className={MUTED}>{t('settings.taskProps.entry.first', { stage: stages[0]?.name.trim() ?? '' })}</span>
            </SelectItem>
            {stages.slice(1).map((s) => (
              <SelectItem key={s.id} value={`stage:${s.id}`} className="pl-6">{s.name.trim()}</SelectItem>
            ))}
          </SelectGroup>
        ))}
        <p className={`px-2 py-1.5 ${MUTED}`}>{t('settings.taskProps.entry.footer')}</p>
      </SelectContent>
    </Select>
  );
}
