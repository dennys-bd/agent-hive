import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { CommandImpls } from '@/components/settings/CommandImpls';
import { EnvEditor } from '@/components/settings/EnvEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { t, tPlural } from '@/i18n';
import { type CommandDraft, emptyCommand, emptyEnvRow, overrides } from '@/lib/settings-commands';
import type { WorkspaceDraft, SettingsDraft } from '@/lib/settings-form';

interface CommandsEditorProps { draft: SettingsDraft; onChange(patch: Partial<SettingsDraft>): void }
interface CommandRowProps {
  row: CommandDraft; n: number; workspaces: WorkspaceDraft[]; expanded: boolean;
  onChange(patch: Partial<CommandDraft>): void; onRemove(): void; onToggle(open: boolean): void;
}

// #755, handoff "8 · por workspace": the second column is a stack of lines, so the row aligns its cells at the top
const GRID = 'grid grid-cols-[8rem_minmax(0,1fr)_7rem_8rem_4.5rem_2rem] items-start gap-3 px-3 py-2';
const COLUMNS = ['name', 'impls', 'timeout', 'env', 'menu'] as const;

// The variables cell (#511): with none, `+ variável` adds a row and opens the panel; with some, their count toggles it.
function VariablesCell({ row, expanded, onChange, onToggle }: Pick<CommandRowProps, 'row' | 'expanded' | 'onChange' | 'onToggle'>) {
  if (row.env.length === 0) {
    const add = (): void => { onChange({ env: [emptyEnvRow()] }); onToggle(true); };
    return <Button type="button" variant="ghost" size="sm" className="justify-start" onClick={add}>{t('settings.env.add')}</Button>;
  }
  const Icon = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Button type="button" variant={expanded ? 'secondary' : 'ghost'} size="sm" className="justify-start" aria-expanded={expanded} onClick={() => onToggle(!expanded)}>
      {tPlural('settings.commands.vars', row.env.length, { n: row.env.length })}
      <Icon aria-hidden />
    </Button>
  );
}

// A command's own variables (#511), under its row: each says which workspace's value it replaces where the command runs.
function CommandEnv({ row, workspaces, onChange }: Pick<CommandRowProps, 'row' | 'workspaces' | 'onChange'>) {
  const label = t('settings.commands.env', { name: row.name.trim() });
  const note = (name: string): string | undefined => {
    const found = overrides(row, workspaces, name);
    return found.length ? found.map(({ value, workspace }) => t('settings.commands.overrides', { value, workspace })).join(' · ') : undefined;
  };
  return (
    <div className="flex flex-col gap-2 border-b bg-background py-3 pr-3 pl-[9.5rem]">
      <span className="text-muted-foreground text-xs">{label}</span>
      <EnvEditor label={label} rows={row.env} note={note} onChange={(env) => onChange({ env })} />
    </div>
  );
}

// no menu (#755): on, the task menu and the detail panel offer the command; off, only a stage runs it, and só etapas says so under the switch
function MenuCell({ row, onChange }: Pick<CommandRowProps, 'row' | 'onChange'>) {
  return (
    <div className="flex flex-col items-center gap-1 pt-2">
      <Switch aria-label={t('settings.commands.menu', { name: row.name.trim() })} checked={row.menu} onCheckedChange={(menu) => onChange({ menu })} />
      {!row.menu && <span className="text-center text-muted-foreground text-xs">{t('settings.commands.stagesOnly')}</span>}
    </div>
  );
}

function CommandRow({ row, n, workspaces, expanded, onChange, onRemove, onToggle }: CommandRowProps) {
  const remove = t('settings.commands.remove', { n });
  return (
    <>
      <fieldset aria-label={t('settings.commands.row', { n })} className={`${GRID} min-w-0 border-b`}>
        <Input aria-label={t('settings.commands.name', { n })} value={row.name} placeholder={t('settings.commands.namePlaceholder')} onChange={(e) => onChange({ name: e.target.value })} />
        <CommandImpls row={row} n={n} workspaces={workspaces} onChange={(impls) => onChange({ impls })} />
        <Input aria-label={t('settings.commands.timeout', { n })} className="font-mono" value={row.timeout} placeholder={t('settings.commands.timeoutPlaceholder')} onChange={(e) => onChange({ timeout: e.target.value })} />
        <VariablesCell row={row} expanded={expanded} onChange={onChange} onToggle={onToggle} />
        <MenuCell row={row} onChange={onChange} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove} onClick={onRemove}><XIcon /></Button>
      </fieldset>
      {expanded && <CommandEnv row={row} workspaces={workspaces} onChange={onChange} />}
    </>
  );
}

/** Settings › workspaces' commands (#300, #511, #755): the Comb's commands as one table, each with a line per workspace, an optional timeout,
 * its own variables folded under its row and whether the task menu offers it; the note under it says how the lines resolve. Which rows are
 * open is view state, never the draft. */
export function CommandsEditor({ draft, onChange }: CommandsEditorProps) {
  const [open, setOpen] = useState<string[]>([]);
  const { commands, workspaces } = draft;
  const update = (id: string, patch: Partial<CommandDraft>): void => onChange({ commands: commands.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const toggle = (id: string) => (on: boolean): void => setOpen((ids) => (on ? [...ids, id] : ids.filter((i) => i !== id)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col rounded-md border">
        <div className={`${GRID} border-b text-muted-foreground text-xs`}>
          {COLUMNS.map((col) => <span key={col} className={col === 'menu' ? 'text-center' : undefined}>{t(`settings.commands.col.${col}`)}</span>)}
          <span />
        </div>
        {commands.map((row, i) => (
          <CommandRow
            key={row.id} row={row} n={i + 1} workspaces={workspaces} expanded={open.includes(row.id) && row.env.length > 0}
            onChange={(patch) => update(row.id, patch)} onRemove={() => onChange({ commands: commands.filter((c) => c.id !== row.id) })} onToggle={toggle(row.id)}
          />
        ))}
        <div className="px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ commands: [...commands, emptyCommand()] })}>{t('settings.commands.add')}</Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('settings.commands.note')}</p>
    </div>
  );
}
