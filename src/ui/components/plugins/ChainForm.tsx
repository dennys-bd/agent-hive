import { XIcon } from 'lucide-react';
import type { VariableKind } from '../../../template';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import {
  addTerm, BUILT_IN, type Draft, type DraftBlock, type DraftOp, type DraftTerm, type FormVariable, isValueRefused, newBlock, offeredOps, takesValue,
  updateBlock, updateTerm, withConnective, withOp,
} from '@/lib/chain-draft';

export interface ChainFormProps {
  draft: Draft; variables: readonly FormVariable[]; onChange(draft: Draft): void;
  reach?: readonly (readonly string[])[]; // the popover's "with today's values": one list per block, the else's last
}
interface Option<V extends string> { value: V; label: string }
interface TermProps { term: DraftTerm; block: DraftBlock; variables: readonly FormVariable[]; onChange(term: DraftTerm): void; onRemove?(): void }
interface BlockProps { label: 'if' | 'else if'; block: DraftBlock; variables: readonly FormVariable[]; reach?: readonly string[]; onChange(block: DraftBlock): void; onRemove?(): void }

const OP_KEY: Record<DraftOp, MessageKey> = {
  is: 'plugins.chain.op.is', isNot: 'plugins.chain.op.isNot', contains: 'plugins.chain.op.contains', hasValue: 'plugins.chain.op.hasValue',
  isBlank: 'plugins.chain.op.isBlank', isOneOf: 'plugins.chain.op.isOneOf', isNo: 'plugins.chain.op.no',
};
// a yes/no variable's hasValue reads "is yes" (decision 6)
const opLabel = (kind: VariableKind, op: DraftOp): string => t(kind === 'boolean' && op === 'hasValue' ? 'plugins.chain.op.yes' : OP_KEY[op]);
const FIELD = 'h-7 text-xs';
const QUIET = 'self-start text-muted-foreground hover:text-foreground';

function Pick<V extends string>({ label, value, options, onChange }: { label: string; value?: V; options: readonly Option<V>[]; onChange(value: V): void }) {
  const pick = (raw: string): void => { const found = options.find((o) => o.value === raw); if (found) onChange(found.value); };
  return (
    <Select value={value ?? ''} onValueChange={pick} disabled={options.length === 0}>
      <SelectTrigger size="sm" aria-label={label} className={FIELD}><SelectValue placeholder="—" /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** "with today's values" under a conditional block (decision 15): the workspaces it reaches, or none. */
export function Reach({ names }: { names: readonly string[] }) {
  return <p className="text-muted-foreground">{t('plugins.chain.reach')}: <span className="font-mono text-foreground">{names.length > 0 ? names.join(', ') : t('plugins.chain.reachNone')}</span></p>;
}

// "is one of…" (decision 5): one checkbox per declared value; the values are written in the order they were checked
function OneOf({ term, variable, onChange }: { term: DraftTerm; variable: FormVariable; onChange(term: DraftTerm): void }) {
  const toggle = (value: string): void => onChange({ ...term, values: term.values.includes(value) ? term.values.filter((v) => v !== value) : [...term.values, value] });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the values
    <div role="group" aria-label={t('plugins.chain.value')} className="flex flex-wrap gap-2">
      {variable.values.map((value) => (
        <label key={value} className="flex items-center gap-1 font-mono">
          <input type="checkbox" checked={term.values.includes(value)} onChange={() => toggle(value)} />{value}
        </label>
      ))}
    </div>
  );
}

// Decision 7: a text value the edits would refuse says why here and keeps insert / ok disabled (specOf answers null)
function TextValue({ term, onChange }: { term: DraftTerm; onChange(term: DraftTerm): void }) {
  const value = term.values[0] ?? '';
  const isRefused = isValueRefused(value);
  return (
    <span className="flex flex-col gap-0.5">
      <Input aria-label={t('plugins.chain.value')} aria-invalid={isRefused} value={value} onChange={(e) => onChange({ ...term, values: [e.target.value] })} className={`${FIELD} font-mono`} />
      {isRefused && <span role="alert" className="text-destructive">{t('plugins.chain.badValue')}</span>}
    </span>
  );
}

function ValueField({ term, variable, onChange }: { term: DraftTerm; variable?: FormVariable; onChange(term: DraftTerm): void }) {
  if (variable === undefined || !takesValue(term.op)) return null;
  if (variable.kind !== 'list') return <TextValue term={term} onChange={onChange} />;
  if (term.op === 'isOneOf') return <OneOf term={term} variable={variable} onChange={onChange} />;
  return <Pick label={t('plugins.chain.value')} value={term.values[0]} options={variable.values.map((v) => ({ value: v, label: v }))} onChange={(v) => onChange({ ...term, values: [v] })} />;
}

function TermRow({ term, block, variables, onChange, onRemove }: TermProps) {
  const variable = variables.find((v) => v.name === term.variable);
  const ops = variable === undefined ? [] : offeredOps(variable.kind, block).map((op) => ({ value: op, label: opLabel(variable.kind, op) }));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Pick label={t('plugins.chain.variable')} value={term.variable} options={variables.map((v) => ({ value: v.name, label: v.name }))} onChange={(name) => onChange({ variable: name, values: [] })} />
      <Pick label={t('plugins.chain.operator')} value={term.op} options={ops} onChange={(op) => onChange(withOp(term, op))} />
      <ValueField term={term} variable={variable} onChange={onChange} />
      {onRemove && <Button type="button" variant="ghost" size="xs" aria-label={t('plugins.chain.removeTerm')} onClick={onRemove}><XIcon /></Button>}
    </div>
  );
}

// Decision 4: one connective per condition, chosen from the second term on; and / or are Liquid's words, in English in every language
function Connective({ value, onChange }: { value: 'and' | 'or'; onChange(value: 'and' | 'or'): void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the toggle
    <div role="group" aria-label={t('plugins.chain.connective')} className="flex rounded-md border">
      {(['and', 'or'] as const).map((c) => (
        <button key={c} type="button" aria-pressed={value === c} onClick={() => onChange(c)} className={`px-1.5 font-mono ${value === c ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}>{c}</button>
      ))}
    </div>
  );
}

function BlockRows({ label, block, variables, reach, onChange, onRemove }: BlockProps) {
  const isMany = block.terms.length > 1;
  const removeTerm = (index: number) => (): void => onChange({ ...block, terms: block.terms.filter((_, at) => at !== index) });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the conditional block
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-muted-foreground">{label}</span>
        {isMany && <Connective value={block.connective} onChange={(c) => onChange(withConnective(block, c))} />}
        {onRemove && <Button type="button" variant="ghost" size="xs" aria-label={t('plugins.chain.removeElsif')} onClick={onRemove}><XIcon /></Button>}
      </div>
      {block.terms.map((term, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a term has no identity; the rows are controlled and hold no state of their own
        <TermRow key={index} term={term} block={block} variables={variables} onChange={(next) => onChange(updateTerm(block, index, () => next))} onRemove={isMany ? removeTerm(index) : undefined} />
      ))}
      <button type="button" onClick={() => onChange(addTerm(block))} className={QUIET}>{t('plugins.chain.addTerm')}</button>
      {reach && <Reach names={reach} />}
    </div>
  );
}

function ElseRow({ draft, reach, onChange }: { draft: Draft; reach?: readonly string[]; onChange(draft: Draft): void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the else and its reach
    <div role="group" aria-label="else" className="flex flex-col gap-1">
      <span className="flex items-center gap-2 font-mono text-muted-foreground">
        <Switch aria-label="else" checked={draft.else} onCheckedChange={(on) => onChange({ ...draft, else: on })} />else
      </span>
      {draft.else && reach && <Reach names={reach} />}
    </div>
  );
}

/** The chain form the "+"'s card and the chip's popover share (#322, decision 3): the if, each else if with ×, "+ else if", the else toggle and
 * the order note; controlled by its Draft. */
export function ChainForm({ draft, variables, reach, onChange }: ChainFormProps) {
  const hasDeclared = variables.some((v) => v.name !== BUILT_IN);
  const removeBlock = (index: number) => (): void => onChange({ ...draft, blocks: draft.blocks.filter((_, at) => at !== index) });
  return (
    <div className="flex flex-col gap-2 text-xs">
      {draft.blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a block has no identity; the rows are controlled and hold no state of their own
        <BlockRows key={index} label={index === 0 ? 'if' : 'else if'} block={block} variables={variables} reach={reach?.[index]} onChange={(next) => onChange(updateBlock(draft, index, () => next))} onRemove={index === 0 ? undefined : removeBlock(index)} />
      ))}
      <button type="button" onClick={() => onChange({ ...draft, blocks: [...draft.blocks, newBlock()] })} className={`${QUIET} font-mono`}>{t('plugins.chain.addElsif')}</button>
      <ElseRow draft={draft} reach={reach?.[draft.blocks.length]} onChange={onChange} />
      <p className="text-muted-foreground">{t('plugins.chain.order')}</p>
      {!hasDeclared && <p className="text-muted-foreground">{t('plugins.chain.noVariables')}</p>}
    </div>
  );
}
