import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';

const NONE = '__none__'; // Radix Select rejects value=""; mapped back to undefined on the way out

interface WorkspaceSelectProps { id: string; label: string; workspaces: string[]; value?: string; allowNone?: boolean; labelHidden?: boolean; fill?: boolean; onChange(workspace: string | undefined): void }

/** A Comb workspace picked by name (#179): the source's default, the + dialog and the start popup. `allowNone` offers "—" for no workspace.
 * `labelHidden` (#514) keeps the label for screen readers only, when a column header already names it visually (the rule table). `fill` (#528)
 * stretches the select across its column where the label stays visible (the new source dialog). */
export function WorkspaceSelect({ id, label, workspaces, value, allowNone = false, labelHidden, fill, onChange }: WorkspaceSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className={labelHidden ? 'sr-only' : undefined}>{label}</Label>
      <Select value={value ?? (allowNone ? NONE : '')} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
        {/* in a table cell (labelHidden) the select fills its column */}
        <SelectTrigger id={id} className={labelHidden || fill ? 'w-full' : undefined}><SelectValue placeholder={t('base.chooseWorkspace')} /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>—</SelectItem>}
          {workspaces.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
