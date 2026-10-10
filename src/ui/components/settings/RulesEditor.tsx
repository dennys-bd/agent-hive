import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { type Consequence, consequenceLabel, consequences, emptyRule, MEASURE_LABEL, MEASURES, type RuleDraft } from '@/lib/settings-rules';
import { RULE_SIGNALS, type RuleSignal, type RuleSource } from '../../../types';

interface RulesEditorProps { rules: RuleDraft[]; stages: string[]; now: Partial<Record<RuleSource, number>>; onChange(rules: RuleDraft[]): void }
interface RuleRowProps { rule: RuleDraft; stages: string[]; now?: number; onUpdate(patch: Partial<RuleDraft>): void; onRemove(): void }

const NONE = '__none__'; // Radix Select rejects value=""; mapped back to '' on the way out
const DOT: Record<RuleSignal, string> = { yellow: 'bg-signal-yellow', red: 'bg-signal-red' };
const SignalDot = ({ signal }: { signal: RuleSignal }) => <span aria-hidden data-signal={signal} className={`size-2.5 rounded-full ${DOT[signal]}`} />;

// A consequence encoded for the Select's value: kind and stage joined, so two "cap" options (total vs. a stage's) stay distinct options.
const key = (c: Consequence): string => `${c.kind}:${c.stage}`;

function ConsequenceSelect({ rule, stages, onUpdate }: { rule: RuleDraft; stages: string[]; onUpdate(patch: Partial<RuleDraft>): void }) {
  const options = consequences(stages, rule);
  const value = rule.kind === '' ? NONE : key({ kind: rule.kind, stage: rule.stage });
  const pick = (v: string): void => {
    if (v === NONE) { onUpdate({ kind: '', stage: '', value: '' }); return; }
    const picked = options.find((c) => key(c) === v);
    if (!picked) return;
    onUpdate({ kind: picked.kind, stage: picked.stage, value: picked.kind === rule.kind ? rule.value : '' });
  };
  return (
    <Select value={value} onValueChange={pick}>
      <SelectTrigger aria-label={t('settings.rules.effect')} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>—</SelectItem>
        {options.map((c) => <SelectItem key={key(c)} value={key(c)}>{consequenceLabel(c)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function MeasureSelect({ rule, onUpdate }: { rule: RuleDraft; onUpdate(patch: Partial<RuleDraft>): void }) {
  return (
    <Select value={rule.source} onValueChange={(v) => onUpdate({ source: v as RuleSource })}>
      <SelectTrigger aria-label={t('settings.rules.measure')} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{MEASURES.map((s) => <SelectItem key={s} value={s}>{t(MEASURE_LABEL[s])}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function ValueCell({ rule, onUpdate }: { rule: RuleDraft; onUpdate(patch: Partial<RuleDraft>): void }) {
  if (rule.kind === 'maxWorkers') {
    return <Input aria-label={t('settings.rules.value')} type="number" min={0} step={1} className="w-20" defaultValue={rule.value} onChange={(e) => onUpdate({ value: e.target.value })} />;
  }
  if (rule.kind === 'signal') {
    return (
      <Select value={rule.value === '' ? NONE : rule.value} onValueChange={(v) => onUpdate({ value: v === NONE ? '' : v })}>
        <SelectTrigger aria-label={t('settings.rules.value')} className="w-28">
          {rule.value === '' ? <SelectValue /> : <span className="flex items-center gap-2"><SignalDot signal={rule.value as RuleSignal} />{rule.value}</span>}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>—</SelectItem>
          {RULE_SIGNALS.map((signal) => <SelectItem key={signal} value={signal}><SignalDot signal={signal} />{signal}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  return <span />;
}

// One grid for the header and the rows: measure, from + %, consequence, value, now, remove.
const GRID = 'grid grid-cols-[13rem_7rem_12rem_minmax(0,1fr)_4.5rem_2rem] items-center gap-3 px-3 py-2';

/** `medida | a partir de | consequência | valor | agora | ×`: one row per RuleDraft. */
function RuleRow({ rule, stages, now, onUpdate, onRemove }: RuleRowProps) {
  return (
    <div data-testid="rule-row" className={`${GRID} border-b`}>
      <MeasureSelect rule={rule} onUpdate={onUpdate} />
      <div className="flex items-center gap-1.5">
        <Input type="number" min={0} max={100} step={1} className="w-[4.5rem]" aria-label={t('settings.rules.from')} defaultValue={rule.percent} onChange={(e) => onUpdate({ percent: e.target.value })} />
        <span className="text-muted-foreground text-xs">%</span>
      </div>
      <ConsequenceSelect rule={rule} stages={stages} onUpdate={onUpdate} />
      <ValueCell rule={rule} onUpdate={onUpdate} />
      <span className="text-muted-foreground text-xs">{now === undefined ? '—' : `${now}%`}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.rules.remove')} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

/** Every rule as one compact table (#526), in draft order so a row never jumps while it is edited; edits and removes go by row id. */
export function RulesEditor({ rules, stages, now, onChange }: RulesEditorProps) {
  const update = (id: string, patch: Partial<RuleDraft>): void => onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string): void => onChange(rules.filter((r) => r.id !== id));

  return (
    <div className="flex flex-col rounded-md border">
      <div className={`${GRID} border-b text-muted-foreground text-xs`}>
        <span>{t('settings.rules.measure')}</span>
        <span>{t('settings.rules.from')}</span>
        <span>{t('settings.rules.effect')}</span>
        <span>{t('settings.rules.value')}</span>
        <span>{t('settings.rules.now')}</span>
        <span />
      </div>
      {rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} stages={stages} now={now[rule.source]} onUpdate={(patch) => update(rule.id, patch)} onRemove={() => remove(rule.id)} />
      ))}
      <div className="px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...rules, emptyRule('session')])}>{t('settings.rules.add')}</Button>
      </div>
    </div>
  );
}
