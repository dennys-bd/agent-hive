import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { emptyRule, type RuleDraft } from '@/lib/setup-form';

interface RulesEditorProps { rules: RuleDraft[]; onChange(rules: RuleDraft[]): void }

const NONE = '__none__'; // Radix Select rejects value=""; mapped back to '' on the way out

function RuleRow({ rule, onUpdate, onRemove }: { rule: RuleDraft; onUpdate(patch: Partial<RuleDraft>): void; onRemove(): void }) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-percent`}>{t('setup.rules.percent')}</Label>
        <Input id={`${id}-percent`} type="number" min={0} max={100} step={1} className="w-20" defaultValue={rule.percent} onChange={(e) => onUpdate({ percent: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-max`}>{t('maxWorkers')}</Label>
        <Input id={`${id}-max`} type="number" min={0} step={1} className="w-20" defaultValue={rule.maxWorkers} onChange={(e) => onUpdate({ maxWorkers: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-signal`}>{t('setup.rules.signal')}</Label>
        <Select value={rule.signal === '' ? NONE : rule.signal} onValueChange={(v) => onUpdate({ signal: v === NONE ? '' : (v as RuleDraft['signal']) })}>
          <SelectTrigger id={`${id}-signal`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            <SelectItem value="green">green</SelectItem>
            <SelectItem value="yellow">yellow</SelectItem>
            <SelectItem value="red">red</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="button" variant="outline" size="xs" onClick={onRemove}>{t('setup.rules.remove')}</Button>
    </div>
  );
}

/** The usage-budget tiers: cumulative signal/cap rows, in order, every update immutable. */
export function RulesEditor({ rules, onChange }: RulesEditorProps) {
  const update = (i: number, patch: Partial<RuleDraft>): void => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number): void => onChange(rules.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a RuleDraft has no stable id; rows have no per-instance state to misattach
        <RuleRow key={i} rule={rule} onUpdate={(patch) => update(i, patch)} onRemove={() => remove(i)} />
      ))}
      <Button type="button" variant="outline" onClick={() => onChange([...rules, emptyRule()])}>{t('setup.rules.add')}</Button>
    </div>
  );
}
