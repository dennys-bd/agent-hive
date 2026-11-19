import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { t } from '@/i18n';

const TEMPLATE = '*'; // "template": no workspace may be named `*` (WORKSPACE_NAME), as the list's filter relies on
const ITEM = 'flex-1 gap-1.5 px-1.5 font-medium data-[state=on]:bg-background data-[state=on]:text-foreground';

interface ViewAsProps { value?: string; workspaces: readonly string[]; onChange(workspace: string | undefined): void; isHinted?: boolean }

/** "View as" at the top of the right pane (#319, decision 22; #492's track): the template, or one workspace's preview, with the line saying
 * which one it is. The protocol pane writes its own line under it, so it passes isHinted false. */
export function ViewAsSelect({ value, workspaces, onChange, isHinted = true }: ViewAsProps) {
  // A single toggle group answers '' when the pressed item is clicked again: the pane always shows one of them
  const pick = (next: string): void => { if (next !== '') onChange(next === TEMPLATE ? undefined : next); };
  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2 text-xs">
      <span className="text-muted-foreground">{t('plugins.viewAs.label')}</span>
      <ToggleGroup type="single" size="xs" aria-label={t('plugins.viewAs.label')} value={value ?? TEMPLATE} onValueChange={pick} className="w-full rounded-md bg-accent p-0.5">
        <ToggleGroupItem value={TEMPLATE} className={ITEM}>{t('plugins.viewAs.template')}</ToggleGroupItem>
        {workspaces.map((w) => (
          <ToggleGroupItem key={w} value={w} className={`${ITEM} min-w-0`}><WorkspaceSquare name={w} /><span className="truncate">{w}</span></ToggleGroupItem>
        ))}
      </ToggleGroup>
      {isHinted && (
        <p className="text-muted-foreground">{value === undefined ? t('plugins.viewAs.hintEdit') : t('plugins.viewAs.hintPreview', { workspace: value })}</p>
      )}
    </div>
  );
}
