import { MultiSelect } from '@/components/settings/MultiSelect';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type MessageKey, t } from '@/i18n';
import { NO_VALUE } from '../../../task-filter.js';
import type { FilterOp, FilterOptions, FilterRule } from '../../../types';

type ValuedRule = Exclude<FilterRule, { field: 'blocked' }>; // #441: a blocked rule has no values to pick
type PlainField = Exclude<ValuedRule['field'], 'projectField'>;

const PLAIN_FIELDS: Record<PlainField, { label: MessageKey; options: Exclude<keyof FilterOptions, 'projectFields'> }> = {
  assignee: { label: 'settings.filter.field.assignee', options: 'assignees' },
  label: { label: 'settings.filter.field.label', options: 'labels' },
  milestone: { label: 'settings.filter.field.milestone', options: 'milestones' },
  repository: { label: 'settings.filter.field.repository', options: 'repositories' },
};
const OP_LABEL: Record<FilterOp, MessageKey> = { any: 'settings.filter.op.any', none: 'settings.filter.op.none' };
// #441: a yes/no criterion; "é qualquer um de" with nothing to pick would make no sense
const BLOCKED_OP_LABEL: Record<FilterOp, MessageKey> = { any: 'settings.filter.op.is', none: 'settings.filter.op.isNot' };
const FIELD_PREFIX = 'projectField:'; // the criterion select's value for a project field; a plain criterion, and blocked, is its own name
const NEW_RULE: FilterRule = { field: 'assignee', op: 'any', values: [] };

interface FilterRulesProps { rules: FilterRule[]; options?: FilterOptions; inSettings?: boolean; onChange(rules: FilterRule[]): void }

// A rule's line: the settings page has the width for the design's fixed columns (#524); the stage filter's dialog does not.
const SETTINGS_LINE = 'grid grid-cols-[200px_200px_minmax(0,1fr)_40px] items-center gap-3';
const DIALOG_LINE = 'flex items-center gap-2';

const criterionOf = (rule: FilterRule): string => (rule.field === 'projectField' ? `${FIELD_PREFIX}${rule.name}` : rule.field);
const opLabels = (rule: FilterRule): Record<FilterOp, MessageKey> => (rule.field === 'blocked' ? BLOCKED_OP_LABEL : OP_LABEL);

// Another criterion keeps the operator and clears the values: the old criterion's values mean nothing under the new one; blocked has none.
function withCriterion(rule: FilterRule, criterion: string): FilterRule {
  if (criterion === 'blocked') return { field: 'blocked', op: rule.op };
  if (criterion.startsWith(FIELD_PREFIX)) return { field: 'projectField', name: criterion.slice(FIELD_PREFIX.length), op: rule.op, values: [] };
  return { field: criterion as PlainField, op: rule.op, values: [] };
}

// The source's real values for the rule: none until they load (or when loading failed), and the picker still takes typed ones. The optional
// reads guard an answer of another shape: it comes over a fetch.
// "nenhum" (#524) is always offered: a task with no value for the criterion, e.g. unassigned, ORed with @me.
function offered(rule: ValuedRule, options?: FilterOptions): string[] {
  if (rule.field === 'projectField') return [NO_VALUE, ...(options?.projectFields?.find((f) => f.name === rule.name)?.options ?? [])];
  return [NO_VALUE, ...(options?.[PLAIN_FIELDS[rule.field].options] ?? [])];
}

const valueLabel = (value: string): string => (value === NO_VALUE ? t('settings.filter.noValue') : value);

/** A github source's task filter (#245), and a stage's view filter (#374): one line per rule, each a criterion, an operator and its values
 * (none for bloqueado, #441); "+ filtro" adds one. `inSettings` (#514, #524): the source detail page, where a SettingsGroup heading already
 * names it (no caption) and the line takes the design's columns. */
export function FilterRules({ rules, options, inSettings = false, onChange }: FilterRulesProps) {
  // a saved rule's field stays listed while the options are not loaded, so the select never holds a value it does not offer
  const fieldNames = [...new Set([...(options?.projectFields ?? []).map((f) => f.name), ...rules.flatMap((r) => (r.field === 'projectField' ? [r.name] : []))])];
  const update = (index: number, rule: FilterRule): void => onChange(rules.map((r, i) => (i === index ? rule : r)));
  return (
    <div className={inSettings ? 'flex flex-col gap-3' : 'flex flex-col gap-2'}>
      {!inSettings && <span className="font-medium text-sm">{t('settings.filter')}</span>}
      {rules.map((rule, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: every control reads the rule itself, so a removal leaves no line showing another's state
        <div key={index} data-testid="filter-rule" className={inSettings ? SETTINGS_LINE : DIALOG_LINE}>
          <Select value={criterionOf(rule)} onValueChange={(v) => update(index, withCriterion(rule, v))}>
            <SelectTrigger aria-label={t('settings.filter.field')} className={inSettings ? 'w-full' : 'w-36'}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(PLAIN_FIELDS) as PlainField[]).map((f) => <SelectItem key={f} value={f}>{t(PLAIN_FIELDS[f].label)}</SelectItem>)}
              {fieldNames.map((name) => <SelectItem key={name} value={`${FIELD_PREFIX}${name}`}>{name}</SelectItem>)}
              <SelectItem value="blocked">{t('settings.filter.field.blocked')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={rule.op} onValueChange={(op) => update(index, { ...rule, op: op as FilterOp })}>
            <SelectTrigger aria-label={t('settings.filter.op')} className={inSettings ? 'w-full' : 'w-40'}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(OP_LABEL) as FilterOp[]).map((op) => <SelectItem key={op} value={op}>{t(opLabels(rule)[op])}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="min-w-0 flex-1">
            {rule.field !== 'blocked' && (
              <MultiSelect
                allowTyped ariaLabel={t('settings.filter.values')} placeholder={t('settings.filter.valuesPlaceholder')} labelOf={valueLabel}
                value={rule.values} options={offered(rule, options)} onChange={(values) => update(index, { ...rule, values })}
              />
            )}
          </div>
          <Button
            type="button" variant="ghost" size="icon-sm" aria-label={t('settings.filter.remove')} title={t('settings.filter.remove')}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rules, NEW_RULE])}>{t('settings.filter.add')}</Button>
    </div>
  );
}
