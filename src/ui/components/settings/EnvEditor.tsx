import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { type EnvRowDraft, emptyEnvRow } from '@/lib/settings-commands';

interface EnvEditorProps { rows: EnvRowDraft[]; label: string; note?(name: string): string | undefined; onChange(rows: EnvRowDraft[]): void }

/** A key/value env editor (#348, #511): a workspace's env or one command's. `label` names the group for assistive tech only, so its rows'
 * numbered labels stay unique on a page with several editors while the caller draws the visible heading; `note` is the text beside a row
 * (a command's override of a workspace value). A + row left blank is dropped on save, never an error. */
export function EnvEditor({ rows, label, note, onChange }: EnvEditorProps) {
  const update = (id: string, patch: Partial<EnvRowDraft>): void => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <fieldset aria-label={label} className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const vars = { n: i + 1 };
        const remove = t('settings.env.remove', vars);
        return (
          <div key={row.id} className="grid grid-cols-[16rem_minmax(0,1fr)_auto_2rem] items-center gap-3">
            <Input aria-label={t('settings.env.name', vars)} className="font-mono" value={row.name} placeholder="PORT" onChange={(e) => update(row.id, { name: e.target.value })} />
            <Input aria-label={t('settings.env.value', vars)} className="font-mono" value={row.value} placeholder="5173" onChange={(e) => update(row.id, { value: e.target.value })} />
            <span className="text-muted-foreground text-xs">{note?.(row.name.trim())}</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove} onClick={() => onChange(rows.filter((r) => r.id !== row.id))}>
              <XIcon />
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, emptyEnvRow()])}>{t('settings.env.add')}</Button>
    </fieldset>
  );
}
