import { useId } from 'react';
import { FromMultiSelect } from '@/components/setup/FromMultiSelect';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { type ColumnDraft, emptyColumn } from '@/lib/setup-form';

interface ColumnEditorProps { columns: ColumnDraft[]; options: string[]; onChange(columns: ColumnDraft[]): void }

const NONE = '__none__'; // Radix Select rejects value=""; mapped back to '' on the way out
const withChosen = (options: string[], chosen: string): string[] => (chosen && !options.includes(chosen) ? [...options, chosen] : options);

interface ColumnRowProps {
  column: ColumnDraft; index: number; total: number; options: string[];
  onUpdate(patch: Partial<ColumnDraft>): void; onMove(to: number): void; onRemove(): void;
}

function ColumnRow({ column, index, total, options, onUpdate, onMove, onRemove }: ColumnRowProps) {
  const id = useId();
  const onStartOptions = withChosen(options, column.onStart);
  const onFinishOptions = withChosen(options, column.onFinish);

  return (
    <Card data-testid="column-row" className="gap-3 p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t('setup.columns.name')}</Label>
          <Input id={`${id}-name`} defaultValue={column.name} onChange={(e) => onUpdate({ name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-weight`}>{t('setup.columns.weight')}</Label>
          <Input id={`${id}-weight`} type="number" min={0} step={1} defaultValue={column.weight} onChange={(e) => onUpdate({ weight: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-visible`}>{t('setup.columns.visible')}</Label>
          <Input id={`${id}-visible`} type="number" min={0} step={1} defaultValue={column.visible} onChange={(e) => onUpdate({ visible: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-session`}>{t('setup.columns.session')}</Label>
          <Select value={column.session} onValueChange={(v) => onUpdate({ session: v as ColumnDraft['session'] })}>
            <SelectTrigger id={`${id}-session`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="new">{t('setup.columns.session.new')}</SelectItem>
              <SelectItem value="continue">{t('setup.columns.session.continue')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-model`}>{t('setup.columns.model')}</Label>
          <Input id={`${id}-model`} defaultValue={column.model} onChange={(e) => onUpdate({ model: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-from`}>{t('setup.columns.from')}</Label>
          <FromMultiSelect value={column.from} options={options} onChange={(from) => onUpdate({ from })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-on-start`}>{t('setup.columns.onStart')}</Label>
          <Select value={column.onStart === '' ? NONE : column.onStart} onValueChange={(v) => onUpdate({ onStart: v === NONE ? '' : v })}>
            <SelectTrigger id={`${id}-on-start`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {onStartOptions.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-on-finish`}>{t('setup.columns.onFinish')}</Label>
          <Select value={column.onFinish === '' ? NONE : column.onFinish} onValueChange={(v) => onUpdate({ onFinish: v === NONE ? '' : v })}>
            <SelectTrigger id={`${id}-on-finish`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {onFinishOptions.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-prompt`}>{t('setup.columns.prompt')}</Label>
        <Textarea id={`${id}-prompt`} rows={2} spellCheck={false} defaultValue={column.prompt} onChange={(e) => onUpdate({ prompt: e.target.value })} />
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="xs" aria-label="↑" disabled={index === 0} onClick={() => onMove(index - 1)}>↑</Button>
        <Button type="button" variant="outline" size="xs" aria-label="↓" disabled={index === total - 1} onClick={() => onMove(index + 1)}>↓</Button>
        <Button type="button" variant="outline" size="xs" onClick={onRemove}>{t('setup.columns.remove')}</Button>
      </div>
    </Card>
  );
}

/** The Hive column pipeline: one row per column, reorderable and removable, every update immutable. */
export function ColumnEditor({ columns, options, onChange }: ColumnEditorProps) {
  const update = (i: number, patch: Partial<ColumnDraft>): void => onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, to: number): void => {
    if (to < 0 || to >= columns.length) return;
    const next = [...columns];
    [next[i], next[to]] = [next[to], next[i]];
    onChange(next);
  };
  const remove = (i: number): void => onChange(columns.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-3">
      {columns.map((column, i) => (
        <ColumnRow
          key={column.id} column={column} index={i} total={columns.length} options={options}
          onUpdate={(patch) => update(i, patch)} onMove={(to) => move(i, to)} onRemove={() => remove(i)}
        />
      ))}
      <Button type="button" variant="outline" onClick={() => onChange([...columns, emptyColumn()])}>{t('setup.columns.add')}</Button>
    </div>
  );
}
