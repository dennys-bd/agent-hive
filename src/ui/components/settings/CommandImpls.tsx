import { HourglassIcon, XIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { type CommandDraft, emptyImpl, freeWorkspaces, type ImplDraft, lineLabel, missingWorkspaces, semaphoreHint, semaphoreLabel, shownWorkspace, stackedImpls } from '@/lib/settings-commands';
import type { WorkspaceDraft } from '@/lib/settings-form';
import type { SemaphoreDraft } from '@/lib/settings-semaphores';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

// A command's line per workspace (#755, handoff "8 · por workspace"): a row per workspace with a line of its own, by name, then the line of the
// other workspaces; + workspace adds the first workspace still without one, and the workspaces left with no line are named under the stack.

/** The select's value for the line with no workspace: a workspace row id is a UUID, never this. */
const OTHERS = 'others';

/** The picker's value for no semaphore (#804 decision 2): a semaphore draft id is a UUID, never this. */
const NONE = 'none';

interface Choice { id: string; label: string; color: string }
interface CommandImplsProps { row: CommandDraft; n: number; workspaces: WorkspaceDraft[]; semaphores: SemaphoreDraft[]; onChange(impls: ImplDraft[]): void }
interface SemaphorePickProps { value?: string; semaphores: SemaphoreDraft[]; command: string; workspace: string; onChange(semaphore: string | undefined): void }
interface ImplRowProps {
  semaphores: SemaphoreDraft[];
  impl: ImplDraft; label: string; color?: string; n: number; name: string; choices: Choice[]; othersLabel?: string;
  onChange(patch: Partial<ImplDraft>): void; onRemove(): void;
}

// #804 decisions 1–5: an icon button inside the command field. Radix's own trigger, since ui/select's draws a bordered field with a chevron;
// the menu's note is not an option, and a link there would not be reachable by keyboard, so the card foot carries it (decision 4)
function SemaphorePick({ value, semaphores, command, workspace, onChange }: SemaphorePickProps) {
  const picked = semaphores.find((s) => s.id === value); // decision 7: an id no draft has reads as none
  const name = picked === undefined ? undefined : semaphoreLabel(picked);
  const label = t('settings.commands.semaphore.label', { command, workspace, semaphore: name ?? t('settings.commands.semaphore.none') });
  return (
    <Select value={picked?.id ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
      <SelectPrimitive.Trigger asChild>
        <Button
          type="button" variant="ghost" size="icon-sm" aria-label={label}
          title={name === undefined ? t('settings.commands.semaphore.titleNone') : t('settings.commands.semaphore.title', { name })}
          className={`absolute top-1 right-1 size-7 ${name === undefined ? 'text-muted-foreground' : 'text-foreground'}`}
        >
          <HourglassIcon aria-hidden />
        </Button>
      </SelectPrimitive.Trigger>
      <SelectContent position="popper" align="end">
        <SelectItem value={NONE}>{t('settings.commands.semaphore.none')}</SelectItem>
        {semaphores.map((s) => <SelectItem key={s.id} value={s.id}>{semaphoreLabel(s)}</SelectItem>)}
        <SelectSeparator />
        <p className="max-w-64 px-2 py-1.5 text-muted-foreground text-xs">{t(semaphores.length === 0 ? 'settings.commands.semaphore.empty' : 'settings.commands.semaphore.note')}</p>
      </SelectContent>
    </Select>
  );
}

// One line: where it runs (a workspace with its square, or the other workspaces with none), the line in mono, and x
function ImplRow({ impl, label, color, n, name, choices, othersLabel, semaphores, onChange, onRemove }: ImplRowProps) {
  return (
    <div className="grid grid-cols-[13.5rem_minmax(0,1fr)_2rem] items-center gap-2">
      <Select value={impl.workspace ?? OTHERS} onValueChange={(value) => onChange({ workspace: value === OTHERS ? null : value })}>
        <SelectTrigger aria-label={t('settings.commands.implWorkspace', { n, workspace: label })} className="w-full">
          <SelectValue>{impl.workspace !== null && <WorkspaceSquare color={color} />}{label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {choices.map((c) => <SelectItem key={c.id} value={c.id}><WorkspaceSquare color={c.color} />{c.label}</SelectItem>)}
          {othersLabel !== undefined && <SelectItem value={OTHERS}>{othersLabel}</SelectItem>}
        </SelectContent>
      </Select>
      <div className="relative min-w-0">
        <Input aria-label={t('settings.commands.command', { n, workspace: label })} className="pr-9 font-mono" value={impl.command} placeholder="pnpm test" onChange={(e) => onChange({ command: e.target.value })} />
        <SemaphorePick value={impl.semaphore} semaphores={semaphores} command={name || `#${n}`} workspace={label} onChange={(semaphore) => onChange({ semaphore })} />
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.commands.removeImpl', { name, workspace: label })} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

/** The comando em cada workspace cell (#755). The line with no workspace reads todos os workspaces alone and os demais workspaces beside rows of
 * their own; each select offers its own workspace, the ones with no line yet, and that line while no other row holds it. */
export function CommandImpls({ row, n, workspaces, semaphores, onChange }: CommandImplsProps) {
  const stacked = stackedImpls(row, workspaces);
  const free = freeWorkspaces(row, workspaces);
  const missing = missingWorkspaces(row, workspaces);
  const others = t(stacked.length > 1 ? 'settings.commands.others' : 'settings.commands.all');
  const hint = semaphoreHint(row, workspaces, semaphores);
  const hasOthers = row.impls.some((i) => i.workspace === null);
  const update = (id: string, patch: Partial<ImplDraft>): void => onChange(row.impls.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {stacked.map((impl) => {
        const own = workspaces.find((p) => p.id === impl.workspace);
        const choices = [...(own ? [own] : []), ...free].map((p) => ({ id: p.id, label: shownWorkspace(workspaces, p), color: p.color }));
        return (
          <ImplRow
            key={impl.id} impl={impl} label={lineLabel(impl, stacked, workspaces)} color={own?.color} n={n} name={row.name.trim()} choices={choices}
            othersLabel={impl.workspace === null || !hasOthers ? others : undefined} semaphores={semaphores}
            onChange={(patch) => update(impl.id, patch)} onRemove={() => onChange(row.impls.filter((i) => i.id !== impl.id))}
          />
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        {free.length > 0 && <Button type="button" variant="ghost" size="sm" aria-label={t('settings.commands.addImplFor', { name: row.name.trim() || `#${n}` })} onClick={() => onChange([...row.impls, emptyImpl(free[0].id)])}>{t('settings.commands.addImpl')}</Button>}
        {hint !== undefined && <span className="inline-flex items-center gap-1 text-muted-foreground text-xs"><HourglassIcon aria-hidden className="size-3 text-foreground" />{hint}</span>}
        {missing.length > 0 && <span className="text-muted-foreground text-xs">{t('settings.commands.missing', { list: missing.map((p) => shownWorkspace(workspaces, p)).join(', ') })}</span>}
      </div>
    </div>
  );
}
