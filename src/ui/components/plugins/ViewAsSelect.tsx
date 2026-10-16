import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';

const TEMPLATE = '*'; // "template": no workspace may be named `*` (WORKSPACE_NAME), as the list's filter relies on

/** "View as" at the top of the right pane (#319, decision 22): the template, or one workspace's preview. 3.7 fills the pane below it. */
export function ViewAsSelect({ value, workspaces, onChange }: { value?: string; workspaces: readonly string[]; onChange(workspace: string | undefined): void }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
      <span className="text-muted-foreground">{t('plugins.viewAs.label')}</span>
      <Select value={value ?? TEMPLATE} onValueChange={(next) => onChange(next === TEMPLATE ? undefined : next)}>
        <SelectTrigger size="sm" aria-label={t('plugins.viewAs.label')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={TEMPLATE}>{t('plugins.viewAs.template')}</SelectItem>
          {workspaces.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
