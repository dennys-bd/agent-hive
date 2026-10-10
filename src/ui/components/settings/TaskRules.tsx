import { PART_TITLE, PropSelect } from '@/components/settings/TaskDefaults';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import { newTaskRule, PROP_LABEL, propDefault, type SourceTaskPropsDraft, type TaskRuleDraft, withoutProp, withProp } from '@/lib/setup-source-task-props';
import { RULE_FIELD_MAX, RULE_VALUE_MAX, RULES_MAX } from '../../../task-props';
import { TASK_PROPS, type RuleOp, type TaskProp } from '../../../types';

interface TaskRulesProps { draft: SourceTaskPropsDraft; workspaces: string[]; onChange(draft: SourceTaskPropsDraft): void }
interface RuleProps { rule: TaskRuleDraft; onUpdate(patch: Partial<TaskRuleDraft>): void }
interface WhenProps extends RuleProps { n: number; first: boolean; last: boolean; onMove(by: -1 | 1): void; onRemove(): void }
interface SetsProps extends RuleProps { draft: SourceTaskPropsDraft; workspaces: string[] }

// The condition and "ignorar case" are two controls (#524) over the one RuleOp the config keeps: equals/contains, each with an i- twin.
type Condition = 'equals' | 'contains';
const CONDITIONS: readonly Condition[] = ['equals', 'contains'];
const CONDITION_LABEL: Record<Condition, MessageKey> = { equals: 'settings.workspaceRules.op.equals', contains: 'settings.workspaceRules.op.contains' };
const OP_OF: Record<Condition, { plain: RuleOp; ignoreCase: RuleOp }> = {
  equals: { plain: 'equals', ignoreCase: 'iequals' }, contains: { plain: 'contains', ignoreCase: 'icontains' },
};
const conditionOf = (op: RuleOp): Condition => (op === 'equals' || op === 'iequals' ? 'equals' : 'contains');
const ignoresCase = (op: RuleOp): boolean => op === 'iequals' || op === 'icontains';
const opOf = (condition: Condition, ignoreCase: boolean): RuleOp => OP_OF[condition][ignoreCase ? 'ignoreCase' : 'plain'];

const WHEN = 'grid grid-cols-[24px_3.5rem_140px_120px_auto_minmax(0,1fr)_104px] items-center gap-2.5';
const SETS = 'grid grid-cols-[24px_3.5rem_minmax(0,1fr)] items-center gap-2.5';
const MUTED = 'text-muted-foreground text-xs';

// `n  when  field · condition · ignore case · value  ↑ ↓ ×` (#293, #524, #688). The limits are the parser's, so the form never types what the
// server would refuse.
function WhenLine({ n, rule, first, last, onUpdate, onMove, onRemove }: WhenProps) {
  const condition = conditionOf(rule.op);
  const ignoreCase = ignoresCase(rule.op);
  return (
    <div className={WHEN}>
      <span className={MUTED}>{n}</span>
      <span className={MUTED}>{t('settings.taskProps.when')}</span>
      <Input aria-label={t('settings.workspaceRules.field')} placeholder={t('settings.workspaceRules.fieldPlaceholder')} maxLength={RULE_FIELD_MAX} defaultValue={rule.field} onChange={(e) => onUpdate({ field: e.target.value })} />
      <Select value={condition} onValueChange={(v) => onUpdate({ op: opOf(v as Condition, ignoreCase) })}>
        <SelectTrigger aria-label={t('settings.workspaceRules.op')} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {CONDITIONS.map((c) => <SelectItem key={c} value={c}>{t(CONDITION_LABEL[c])}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Switch aria-label={t('settings.workspaceRules.ignoreCase')} checked={ignoreCase} onCheckedChange={(on) => onUpdate({ op: opOf(condition, on) })} />
        <span className={MUTED}>{t('settings.workspaceRules.ignoreCase')}</span>
      </div>
      <Input aria-label={t('settings.workspaceRules.value')} placeholder={t('settings.workspaceRules.value')} maxLength={RULE_VALUE_MAX} defaultValue={rule.value} onChange={(e) => onUpdate({ value: e.target.value })} />
      <div className="flex items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="↑" disabled={first} onClick={() => onMove(-1)}>↑</Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="↓" disabled={last} onClick={() => onMove(1)}>↓</Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.workspaceRules.remove')} onClick={onRemove}>×</Button>
      </div>
    </div>
  );
}

// + property (#688): a menu of the properties the rule does not set yet; gone once it sets them all.
function AddProp({ missing, onAdd }: { missing: TaskProp[]; onAdd(prop: TaskProp): void }) {
  if (missing.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">{t('settings.taskProps.addProp')}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {missing.map((prop) => <DropdownMenuItem key={prop} onSelect={() => onAdd(prop)}>{t(PROP_LABEL[prop])}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// `sets` and one chip per property the rule sets (#688): its name, its value and ×, in registry order; then + property.
function SetsLine({ rule, draft, workspaces, onUpdate }: SetsProps) {
  const put = (set: TaskRuleDraft['set']): void => onUpdate({ set });
  return (
    <div className={SETS}>
      <span />
      <span className={MUTED}>{t('settings.taskProps.sets')}</span>
      <div className="flex flex-wrap items-center gap-2">
        {TASK_PROPS.flatMap((prop) => {
          const value = rule.set[prop];
          if (value === undefined) return [];
          return [(
            <div key={prop} data-testid="task-rule-chip" className="flex items-center gap-1 rounded-md border bg-background py-0.5 pr-0.5 pl-2.5">
              <span className={MUTED}>{t(PROP_LABEL[prop])}</span>
              <PropSelect prop={prop} value={value} workspaces={workspaces} small label={t(PROP_LABEL[prop])} onChange={(v) => put(withProp(rule.set, prop, v))} />
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.taskProps.unset')} onClick={() => put(withoutProp(rule.set, prop))}>×</Button>
            </div>
          )];
        })}
        <AddProp missing={TASK_PROPS.filter((prop) => rule.set[prop] === undefined)} onAdd={(prop) => put(withProp(rule.set, prop, propDefault(draft, prop, workspaces)))} />
      </div>
    </div>
  );
}

/** The rules part (#688): top to bottom as they are tried, each a `when` line and a `sets` line, ending on + rule. Every update is a new draft. */
export function TaskRules({ draft, workspaces, onChange }: TaskRulesProps) {
  const { rules } = draft;
  const put = (next: TaskRuleDraft[]): void => onChange({ ...draft, rules: next });
  const update = (i: number, patch: Partial<TaskRuleDraft>): void => put(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: -1 | 1): void => {
    const next = [...rules];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    put(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className={PART_TITLE}>{t('settings.taskProps.rules')}</h3>
        <span className={MUTED}>{t('settings.taskProps.rulesHint')}</span>
      </div>
      <div className="rounded-md border">
        {rules.map((rule, i) => (
          <div key={rule.id} data-testid="task-rule" className="flex flex-col gap-2 border-b px-3 py-2.5">
            <WhenLine n={i + 1} rule={rule} first={i === 0} last={i === rules.length - 1} onUpdate={(patch) => update(i, patch)} onMove={(by) => move(i, by)} onRemove={() => put(rules.filter((_, j) => j !== i))} />
            <SetsLine rule={rule} draft={draft} workspaces={workspaces} onUpdate={(patch) => update(i, patch)} />
          </div>
        ))}
        <div className="px-3 py-2">
          <Button type="button" variant="ghost" size="sm" disabled={rules.length >= RULES_MAX} onClick={() => put([...rules, newTaskRule(draft, workspaces)])}>
            {t('settings.workspaceRules.add')}
          </Button>
        </div>
      </div>
      <p className={MUTED}>{t('settings.workspaceRules.fieldHint')}</p>
    </div>
  );
}
