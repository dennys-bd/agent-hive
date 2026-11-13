import { XIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import type { CommandDraft } from '@/lib/settings-commands';
import type { SettingsDraft, WorkspaceDraft } from '@/lib/settings-form';
import { emptySemaphore, type SemaphoreDraft, semaphoreFaults, semaphoreLines, semaphoreNow, withoutSemaphore } from '@/lib/settings-semaphores';
import type { SemaphoreState } from '../../../types';

interface CommandSemaphoresCardProps {
  semaphores: SemaphoreDraft[]; commands: CommandDraft[]; workspaces: WorkspaceDraft[];
  live?: Readonly<Record<string, SemaphoreState>>; // State.semaphores (#798): the now column, redrawn on every state push
  onChange(patch: Partial<SettingsDraft>): void; onOpenWorkspaces(): void;
}
interface SemaphoreRowProps { row: SemaphoreDraft; rows: SemaphoreDraft[]; lines: string; now: readonly string[]; isAdded: boolean; onUpdate(patch: Partial<SemaphoreDraft>): void; onRemove(): void }

// The screen's .tbl.sems: name, at the same time, turn reservation, commands, now, remove
const GRID = 'grid grid-cols-[9rem_7.5rem_7.5rem_minmax(0,1fr)_9rem_2rem] items-center gap-3 px-3 py-2';

function Header() {
  return (
    <div className={`${GRID} border-b text-muted-foreground text-xs`}>
      <span>{t('settings.semaphores.name')}</span>
      <span>{t('settings.semaphores.limit')}</span>
      <span title={t('settings.semaphores.reservation.title')}>{t('settings.semaphores.reservation')}</span>
      <span>{t('settings.semaphores.commands')}</span>
      <span>{t('settings.semaphores.now')}</span>
      <span />
    </div>
  );
}

// The runs stand out only beside a line, as the screen draws them
function NowCell({ parts }: { parts: readonly string[] }) {
  return (
    <span className="text-muted-foreground text-xs">
      {parts.map((part, i) => (
        <Fragment key={part}>{i > 0 && ' · '}<span className={i === 0 && parts.length > 1 ? 'text-foreground' : undefined}>{part}</span></Fragment>
      ))}
    </span>
  );
}

function SemaphoreRow({ row, rows, lines, now, isAdded, onUpdate, onRemove }: SemaphoreRowProps) {
  const faults = semaphoreFaults(rows, row);
  const name = row.name.trim() || t('settings.semaphores.unnamed'); // a fresh row's accessible names never start with ": "
  return (
    <div data-testid="semaphore-row" className={`${GRID} border-b`}>
      <Input className="font-mono" aria-label={t('settings.semaphores.nameLabel')} autoFocus={isAdded} aria-invalid={faults.name || undefined} value={row.name} onChange={(e) => onUpdate({ name: e.target.value })} />
      <Input type="number" min={1} step={1} aria-label={t('settings.semaphores.limitOf', { name })} aria-invalid={faults.limit || undefined} value={row.limit} onChange={(e) => onUpdate({ limit: e.target.value })} />
      <Input className="font-mono" aria-label={t('settings.semaphores.reservationOf', { name })} aria-invalid={faults.reservation || undefined} value={row.reservation} onChange={(e) => onUpdate({ reservation: e.target.value })} />
      <span className="min-w-0 text-muted-foreground text-xs">{lines}</span>
      <NowCell parts={now} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.semaphores.remove', { name })} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

/** Settings › rules' Command Semaphores (#803): a row per semaphore in draft order, edits and removals by row id; the column header comes with the
 * first row (decision 1). */
export function CommandSemaphoresCard({ semaphores, commands, workspaces, live, onChange, onOpenWorkspaces }: CommandSemaphoresCardProps) {
  const [added, setAdded] = useState<string>(); // decision 6: the row + revezamento made, whose name takes the focus
  const update = (id: string, patch: Partial<SemaphoreDraft>): void => onChange({ commandSemaphores: semaphores.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  // decision 4: no confirmation, the save is it; the lines pointing at the row lose it in the same patch
  const remove = (id: string): void => onChange({ commandSemaphores: semaphores.filter((s) => s.id !== id), commands: withoutSemaphore(commands, id) });
  const add = (): void => { const row = emptySemaphore(); setAdded(row.id); onChange({ commandSemaphores: [...semaphores, row] }); };
  return (
    <SettingsGroup title="settings.semaphores.title" hint="settings.semaphores.hint">
      <div className="flex flex-col rounded-md border">
        {semaphores.length > 0 && <Header />}
        {semaphores.map((row) => (
          <SemaphoreRow
            key={row.id} row={row} rows={semaphores} lines={semaphoreLines(commands, workspaces, row.id)} now={semaphoreNow(live, row)}
            isAdded={row.id === added} onUpdate={(patch) => update(row.id, patch)} onRemove={() => remove(row.id)}
          />
        ))}
        <div className="flex items-center gap-3 px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={add}>{t('settings.semaphores.add')}</Button>
          <span className="text-muted-foreground text-xs">{t('settings.semaphores.empty')}</span>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('settings.semaphores.foot')}{' '}
        <button type="button" className="text-review" onClick={onOpenWorkspaces}>{t('settings.semaphores.foot.link')}</button>
        {t('settings.semaphores.foot.after')}
      </p>
    </SettingsGroup>
  );
}
