import { ChevronDownIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { VariableKind } from '../../../template';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import {
  addTerm, BUILT_IN, type Draft, type DraftBlock, type DraftOp, type DraftTerm, type FormVariable, isValueRefused, newBlock, offeredOps, takesValue,
  updateBlock, updateTerm, withConnective, withOp,
} from '@/lib/chain-draft';

/** The popover's else line (#492): the else marker's line, and the jump that moves the editor there. */
export interface ElseJump { line: number; onJump(): void }
export interface ChainFormProps {
  draft: Draft; variables: readonly FormVariable[]; onChange(draft: Draft): void;
  reach?: readonly (readonly string[])[]; // the "with today's values" panels: one list per block, the else's last
  canAddTerm?: boolean; // "+ and / or" lives in the popover only (#492)
  elseJump?: ElseJump;
}
interface Option<V extends string> { value: V; label: string; symbol?: string }
interface PickProps<V extends string> { label: string; value?: V; options: readonly Option<V>[]; heading?: string; className?: string; onChange(value: V): void }
interface TermProps { term: DraftTerm; block: DraftBlock; variables: readonly FormVariable[]; onChange(term: DraftTerm): void }
interface BlockProps {
  label: 'if' | 'else if'; block: DraftBlock; variables: readonly FormVariable[]; reach?: readonly string[]; canAddTerm: boolean;
  onChange(block: DraftBlock): void; onRemove?(): void;
}

const OP_KEY: Record<DraftOp, MessageKey> = {
  is: 'plugins.chain.op.is', isNot: 'plugins.chain.op.isNot', contains: 'plugins.chain.op.contains', hasValue: 'plugins.chain.op.hasValue',
  isBlank: 'plugins.chain.op.isBlank', isOneOf: 'plugins.chain.op.isOneOf', isNo: 'plugins.chain.op.no',
};
// The Liquid each operator writes, shown muted in the list (#492's handoff); hasValue writes the bare variable
const OP_SYMBOL: Record<Exclude<DraftOp, 'hasValue'>, string> = { is: '==', isNot: '!=', contains: 'contains', isBlank: '== blank', isOneOf: 'or', isNo: '== false' };
const KIND_KEY: Record<VariableKind, MessageKey> = { text: 'plugins.variables.form.text', list: 'plugins.variables.form.list', boolean: 'plugins.variables.form.boolean' };
// a yes/no variable's hasValue reads "is yes" (decision 6)
const opLabel = (kind: VariableKind, op: DraftOp): string => t(kind === 'boolean' && op === 'hasValue' ? 'plugins.chain.op.yes' : OP_KEY[op]);
const FIELD = 'h-7 w-full text-xs';
const QUIET = 'self-start text-muted-foreground hover:text-foreground';
const BOX = 'flex flex-col gap-1.5 rounded-md border p-2';
const CLOSE = 'size-4 text-muted-foreground hover:text-foreground';

// The trigger shows the label alone: an option's symbol is the list's, not the field's
/** "with today's values" under a conditional block (decision 15, #492's panel): each workspace it reaches, or none. */
export function Reach({ names, isElse = false }: { names: readonly string[]; isElse?: boolean }) {
  const word = t(isElse ? 'plugins.chain.otherwise' : 'plugins.chain.enters');
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-sunken px-2 py-1.5">
      <span className="text-muted-foreground">{t('plugins.chain.reach')}</span>
      <div className="flex flex-wrap gap-2.5">
        {names.length === 0 ? <span>{t('plugins.chain.reachNone')}</span> : names.map((name) => (
          <span key={name} className="flex items-center gap-1.5"><WorkspaceSquare name={name} />{name} <span className="text-muted-foreground">{`· ${word}`}</span></span>
        ))}
      </div>
    </div>
  );
}

function Pick<V extends string>({ label, value, options, heading, className = '', onChange }: PickProps<V>) {
  const pick = (raw: string): void => { const found = options.find((o) => o.value === raw); if (found) onChange(found.value); };
  const shown = options.find((o) => o.value === value)?.label;
  return (
    <Select value={value ?? ''} onValueChange={pick} disabled={options.length === 0}>
      <SelectTrigger size="sm" aria-label={label} className={`${FIELD} ${className}`}><SelectValue placeholder="—">{shown}</SelectValue></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {heading && <SelectLabel>{heading}</SelectLabel>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}{o.symbol && <code aria-hidden="true" className="ml-auto pl-3 font-mono text-muted-foreground text-xs">{o.symbol}</code>}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
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
    <span className="flex min-w-0 flex-col gap-0.5">
      <Input aria-label={t('plugins.chain.value')} aria-invalid={isRefused} value={value} onChange={(e) => onChange({ ...term, values: [e.target.value] })} className={`${FIELD} font-mono`} />
      {isRefused && <span role="alert" className="text-destructive">{t('plugins.chain.badValue')}</span>}
    </span>
  );
}

function ValueField({ term, variable, onChange }: { term: DraftTerm; variable?: FormVariable; onChange(term: DraftTerm): void }) {
  if (variable === undefined || !takesValue(term.op)) return null;
  if (variable.kind !== 'list') return <TextValue term={term} onChange={onChange} />;
  if (term.op === 'isOneOf') return <OneOf term={term} variable={variable} onChange={onChange} />;
  return <Pick label={t('plugins.chain.value')} value={term.values[0]} options={variable.values.map((v) => ({ value: v, label: v }))} className="font-mono" onChange={(v) => onChange({ ...term, values: [v] })} />;
}

// The variable full width, then the operator and the value under it (#492's handoff)
function TermFields({ term, block, variables, onChange }: TermProps) {
  const variable = variables.find((v) => v.name === term.variable);
  const ops = variable === undefined ? [] : offeredOps(variable.kind, block).map((op) => ({
    value: op, label: opLabel(variable.kind, op), symbol: op === 'hasValue' ? variable.name : OP_SYMBOL[op],
  }));
  const heading = variable && `${variable.name} · ${t(KIND_KEY[variable.kind])}`;
  return (
    <>
      <Pick label={t('plugins.chain.variable')} value={term.variable} options={variables.map((v) => ({ value: v.name, label: v.name }))} className="font-mono" onChange={(name) => onChange({ variable: name, values: [] })} />
      <div className={`grid gap-1.5 ${takesValue(term.op) ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-1'}`}>
        <Pick label={t('plugins.chain.operator')} value={term.op} options={ops} heading={heading} onChange={(op) => onChange(withOp(term, op))} />
        <ValueField term={term} variable={variable} onChange={onChange} />
      </div>
    </>
  );
}

// Decision 4: one connective per condition, chosen from the second term on; and / or are Liquid's words, in English in every language
function Connective({ value, onChange }: { value: 'and' | 'or'; onChange(value: 'and' | 'or'): void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the toggle
    <div role="group" aria-label={t('plugins.chain.connective')} className="flex rounded-md border p-px font-mono">
      {(['and', 'or'] as const).map((c) => (
        <button key={c} type="button" aria-pressed={value === c} onClick={() => onChange(c)} className={`rounded-sm px-2 ${value === c ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>{c}</button>
      ))}
    </div>
  );
}

// A term after the first: under a dashed line, the block's connective and its ×
function ExtraTerm({ block, onBlock, onRemove, children }: { block: DraftBlock; onBlock(block: DraftBlock): void; onRemove(): void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-dashed pt-1.5">
      <div className="flex items-center justify-between gap-1.5">
        <Connective value={block.connective} onChange={(c) => onBlock(withConnective(block, c))} />
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t('plugins.chain.removeTerm')} onClick={onRemove} className={CLOSE}><XIcon /></Button>
      </div>
      {children}
    </div>
  );
}

function BlockRows({ label, block, variables, reach, canAddTerm, onChange, onRemove }: BlockProps) {
  const removeTerm = (index: number) => (): void => onChange({ ...block, terms: block.terms.filter((_, at) => at !== index) });
  const fieldsOf = (term: DraftTerm, index: number): ReactNode => <TermFields term={term} block={block} variables={variables} onChange={(next) => onChange(updateTerm(block, index, () => next))} />;
  const [first, ...rest] = block.terms;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the conditional block
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <div className={BOX}>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>{label}</span>
          {onRemove && <Button type="button" variant="ghost" size="icon-xs" aria-label={t('plugins.chain.removeElsif')} onClick={onRemove} className={CLOSE}><XIcon /></Button>}
        </div>
        {first && fieldsOf(first, 0)}
        {rest.map((term, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a term has no identity; the rows are controlled and hold no state of their own
          <ExtraTerm key={at} block={block} onBlock={onChange} onRemove={removeTerm(at + 1)}>{fieldsOf(term, at + 1)}</ExtraTerm>
        ))}
        {canAddTerm && <button type="button" onClick={() => onChange(addTerm(block))} className={QUIET}>{t('plugins.chain.addTerm')}</button>}
      </div>
      {reach && <Reach names={reach} />}
    </div>
  );
}

// The else's own box, its switch on the right; in the popover, its line moves the editor there (#492)
function ElseRow({ draft, reach, elseJump, onChange }: { draft: Draft; reach?: readonly string[]; elseJump?: ElseJump; onChange(draft: Draft): void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the else and its reach
    <div role="group" aria-label="else" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 rounded-md border p-2">
        <span className="flex-1 font-mono text-muted-foreground">
          {elseJump ? (
            <button type="button" onClick={elseJump.onJump} className="inline-flex items-center gap-0.5 hover:text-foreground">
              {t('plugins.chain.elseLine', { line: elseJump.line })}<ChevronDownIcon className="size-3" />
            </button>
          ) : 'else'}
        </span>
        <Switch aria-label="else" checked={draft.else} onCheckedChange={(on) => onChange({ ...draft, else: on })} />
      </div>
      {draft.else && reach && <Reach names={reach} isElse />}
    </div>
  );
}

/** The chain form the "+"'s card and the chip's popover share (#322, decision 3): a box per if and else if, "+ else if", the else's box, each
 * block's reach and the order note; controlled by its Draft. */
export function ChainForm({ draft, variables, reach, canAddTerm = false, elseJump, onChange }: ChainFormProps) {
  const hasDeclared = variables.some((v) => v.name !== BUILT_IN);
  const removeBlock = (index: number) => (): void => onChange({ ...draft, blocks: draft.blocks.filter((_, at) => at !== index) });
  return (
    <div className="flex flex-col gap-2 text-xs">
      {draft.blocks.map((block, index) => (
        <BlockRows
          // biome-ignore lint/suspicious/noArrayIndexKey: a block has no identity; the rows are controlled and hold no state of their own
          key={index} label={index === 0 ? 'if' : 'else if'} block={block} variables={variables} reach={reach?.[index]} canAddTerm={canAddTerm}
          onChange={(next) => onChange(updateBlock(draft, index, () => next))} onRemove={index === 0 ? undefined : removeBlock(index)}
        />
      ))}
      <button type="button" onClick={() => onChange({ ...draft, blocks: [...draft.blocks, newBlock()] })} className={`${QUIET} font-mono`}>{t('plugins.chain.addElsif')}</button>
      <ElseRow draft={draft} reach={reach?.[draft.blocks.length]} elseJump={elseJump} onChange={onChange} />
      <p className="text-muted-foreground">{t('plugins.chain.order')}</p>
      {!hasDeclared && <p className="text-muted-foreground">{t('plugins.chain.noVariables')}</p>}
    </div>
  );
}
