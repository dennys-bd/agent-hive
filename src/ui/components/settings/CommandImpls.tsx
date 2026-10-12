import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { type CommandDraft, emptyImpl, freeWorkspaces, type ImplDraft, missingWorkspaces, stackedImpls } from '@/lib/settings-commands';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

// A command's line per workspace (#755, handoff "8 · por workspace"): a row per workspace with a line of its own, by name, then the line of the
// other workspaces; + workspace adds the first workspace still without one, and the workspaces left with no line are named under the stack.

/** The select's value for the line with no workspace: a workspace row id is a UUID, never this. */
const OTHERS = 'others';

interface Choice { id: string; label: string; color: string }
interface CommandImplsProps { row: CommandDraft; n: number; workspaces: WorkspaceDraft[]; onChange(impls: ImplDraft[]): void }
interface ImplRowProps {
  impl: ImplDraft; label: string; color?: string; n: number; name: string; choices: Choice[]; othersLabel?: string;
  onChange(patch: Partial<ImplDraft>): void; onRemove(): void;
}

// A row still unnamed reads as the name field's own label, numbered, as the workspace cards' fields do
const shown = (workspaces: readonly WorkspaceDraft[], p: WorkspaceDraft): string => p.name.trim() || `${t('settings.workspaces.name')} ${workspaces.indexOf(p) + 1}`;

// One line: where it runs (a workspace with its square, or the other workspaces with none), the line in mono, and x
function ImplRow({ impl, label, color, n, name, choices, othersLabel, onChange, onRemove }: ImplRowProps) {
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
      <Input aria-label={t('settings.commands.command', { n, workspace: label })} className="font-mono" value={impl.command} placeholder="pnpm test" onChange={(e) => onChange({ command: e.target.value })} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.commands.removeImpl', { name, workspace: label })} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

/** The comando em cada workspace cell (#755). The line with no workspace reads todos os workspaces alone and os demais workspaces beside rows of
 * their own; each select offers its own workspace, the ones with no line yet, and that line while no other row holds it. */
export function CommandImpls({ row, n, workspaces, onChange }: CommandImplsProps) {
  const stacked = stackedImpls(row, workspaces);
  const free = freeWorkspaces(row, workspaces);
  const missing = missingWorkspaces(row, workspaces);
  const others = t(stacked.length > 1 ? 'settings.commands.others' : 'settings.commands.all');
  const hasOthers = row.impls.some((i) => i.workspace === null);
  const update = (id: string, patch: Partial<ImplDraft>): void => onChange(row.impls.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {stacked.map((impl) => {
        const own = workspaces.find((p) => p.id === impl.workspace);
        const choices = [...(own ? [own] : []), ...free].map((p) => ({ id: p.id, label: shown(workspaces, p), color: p.color }));
        return (
          <ImplRow
            key={impl.id} impl={impl} label={own ? shown(workspaces, own) : others} color={own?.color} n={n} name={row.name.trim()} choices={choices}
            othersLabel={impl.workspace === null || !hasOthers ? others : undefined}
            onChange={(patch) => update(impl.id, patch)} onRemove={() => onChange(row.impls.filter((i) => i.id !== impl.id))}
          />
        );
      })}
      <div className="flex items-center gap-3">
        {free.length > 0 && <Button type="button" variant="ghost" size="sm" aria-label={t('settings.commands.addImplFor', { name: row.name.trim() || `#${n}` })} onClick={() => onChange([...row.impls, emptyImpl(free[0].id)])}>{t('settings.commands.addImpl')}</Button>}
        {missing.length > 0 && <span className="text-muted-foreground text-xs">{t('settings.commands.missing', { list: missing.map((p) => shown(workspaces, p)).join(', ') })}</span>}
      </div>
    </div>
  );
}
