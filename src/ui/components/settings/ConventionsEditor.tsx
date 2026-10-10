import { XIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { CHOICES, type ConventionRowDraft, rowFor, unusedKeys } from '@/lib/settings-conventions';
import { type ConventionKey, isConventionKey, SLICE_SIZE_MAX, SLICE_SIZE_MIN } from '../../../conventions';

interface ConventionsEditorProps { rows: ConventionRowDraft[]; label: string; onChange(rows: ConventionRowDraft[]): void }
interface ValueProps { row: ConventionRowDraft; n: number; onChange(row: ConventionRowDraft): void }
interface RowProps extends ValueProps { keys: ConventionKey[]; languages: string; onRemove(): void }

// Suggestions only (#692): an agent writes in any language, so the field takes whatever is typed. Each name in its own language.
const LANGUAGES = ['English', 'Português', 'Español', 'Français', 'Deutsch', 'Italiano', '日本語', '中文'];
const LANGUAGE_KEYS: readonly ConventionKey[] = ['docsLanguage', 'chatLanguage'];

// delivery and featureFlags (#692): only the parser's options
function ChoiceSelect({ row, n, onChange }: ValueProps) {
  return (
    <Select value={row.value} onValueChange={(value) => onChange({ ...row, value })}>
      <SelectTrigger aria-label={t('settings.conventions.value', { n })} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{(CHOICES[row.key] ?? []).map((c) => <SelectItem key={c.value} value={c.value}>{t(c.label)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// The slice size's target range (#692): two whole numbers
function SliceSizeFields({ row, n, onChange }: ValueProps) {
  const bounds = { type: 'number', min: SLICE_SIZE_MIN, max: SLICE_SIZE_MAX, step: 1 } as const;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Input aria-label={t('settings.conventions.min', { n })} {...bounds} placeholder="300" value={row.min} onChange={(e) => onChange({ ...row, min: e.target.value })} />
      <Input aria-label={t('settings.conventions.max', { n })} {...bounds} placeholder="550" value={row.max} onChange={(e) => onChange({ ...row, max: e.target.value })} />
    </div>
  );
}

/** The control a row's key takes (#692): a select for an enumeration, two numbers for the slice size, a text area for the UI check, a text field
 * for the rest, the language suggestions on the two languages. */
function ValueControl({ row, n, languages, onChange }: ValueProps & { languages: string }) {
  const label = t('settings.conventions.value', { n });
  if (CHOICES[row.key]) return <ChoiceSelect row={row} n={n} onChange={onChange} />;
  if (row.key === 'sliceSize') return <SliceSizeFields row={row} n={n} onChange={onChange} />;
  if (row.key === 'uiCheck') return <Textarea aria-label={label} rows={3} value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} />;
  const isLanguage = LANGUAGE_KEYS.includes(row.key);
  return (
    <Input
      aria-label={label} className={isLanguage ? undefined : 'font-mono'} list={isLanguage ? languages : undefined} spellCheck={false}
      value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })}
    />
  );
}

// One row (#692): the key, its control with the key's hint under it, and ×. A new key starts that key's row afresh, same id.
function ConventionRow({ row, n, keys, languages, onChange, onRemove }: RowProps) {
  const remove = t('settings.conventions.remove', { n });
  return (
    <div className="grid grid-cols-[14rem_minmax(0,1fr)_2rem] items-start gap-3">
      <Select value={row.key} onValueChange={(key) => { if (isConventionKey(key)) onChange(rowFor(key, row.id)); }}>
        <SelectTrigger aria-label={t('settings.conventions.key', { n })} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{keys.map((key) => <SelectItem key={key} value={key}>{t(`settings.conventions.label.${key}`)}</SelectItem>)}</SelectContent>
      </Select>
      <div className="flex min-w-0 flex-col gap-1">
        <ValueControl row={row} n={n} languages={languages} onChange={onChange} />
        <p className="text-muted-foreground text-xs">{t(`settings.conventions.about.${row.key}`)}</p>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

/** A workspace's conventions (#692), shaped like the env editor: a row per convention set, its key among the ones not used yet and the
 * control that key takes; + adds the next unused key while any remains. `label` names the group for assistive tech only, so several
 * workspaces' rows stay apart. A row left blank is dropped on save, never an error. */
export function ConventionsEditor({ rows, label, onChange }: ConventionsEditorProps) {
  const languages = useId();
  const replace = (next: ConventionRowDraft): void => onChange(rows.map((r) => (r.id === next.id ? next : r)));
  const [nextKey] = unusedKeys(rows);
  return (
    <fieldset aria-label={label} className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <ConventionRow
          key={row.id} row={row} n={i + 1} keys={unusedKeys(rows, row.key)} languages={languages} onChange={replace}
          onRemove={() => onChange(rows.filter((r) => r.id !== row.id))}
        />
      ))}
      <datalist id={languages}>{LANGUAGES.map((name) => <option key={name} value={name} />)}</datalist>
      {nextKey !== undefined && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, rowFor(nextKey)])}>{t('settings.conventions.add')}</Button>
      )}
    </fieldset>
  );
}
