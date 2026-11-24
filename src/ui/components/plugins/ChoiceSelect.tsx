// The variables form's choices (#321): a list's values or yes / no after one empty option
import type { VariableKind, VariableValue } from '../../../template';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';

const EMPTY = '\0empty'; // Radix refuses '' as an item's value; a NUL is in no list value
const FALLBACK_TONE = 'italic text-muted-foreground';

/** A raw value as the header writes it: '' is no value (the default applies), true / false for a yes/no, the text otherwise. */
export function valueOfRaw(kind: VariableKind, raw: string): VariableValue | undefined {
  if (raw === '') return undefined;
  return kind === 'boolean' ? raw === 'true' : raw;
}

/** A value as the raw string the controls hold: '' for none and for null. */
export const rawOf = (value: VariableValue | undefined): string => (value === undefined || value === null ? '' : String(value));

interface ChoiceSelectProps {
  kind: VariableKind; values: readonly string[]; raw: string; label: string; emptyLabel: string;
  className?: string; isDisabled?: boolean; onChange(raw: string): void;
}

/** The empty option reads what an empty field falls back to, in italics as the trigger shows it. A value the choices do not hold (a workspace
 * value this declaration cannot take, #621 decision 3) stays shown, red, until an accepted one is picked. */
export function ChoiceSelect({ kind, values, raw, label, emptyLabel, className = '', isDisabled = false, onChange }: ChoiceSelectProps) {
  const choices: [string, string][] = kind === 'boolean'
    ? [['true', t('plugins.variables.yes')], ['false', t('plugins.variables.no')]]
    : values.map((value) => [value, value]);
  const isUnaccepted = raw !== '' && !choices.some(([value]) => value === raw);
  const tone = raw === '' ? FALLBACK_TONE : isUnaccepted ? 'text-destructive' : '';
  return (
    <Select value={raw === '' ? EMPTY : raw} disabled={isDisabled} onValueChange={(next) => onChange(next === EMPTY ? '' : next)}>
      <SelectTrigger size="sm" aria-label={label} className={`h-6 min-w-0 font-mono text-xs ${tone} ${className}`}>{isUnaccepted ? raw : <SelectValue />}</SelectTrigger>
      <SelectContent>
        <SelectItem value={EMPTY} className={FALLBACK_TONE}>{emptyLabel}</SelectItem>
        {choices.map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
