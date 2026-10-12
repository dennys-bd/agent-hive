import { baseRemote } from '../../../fork';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRemotes } from '@/hooks/use-remotes';
import { t } from '@/i18n';
import type { SettingsDraft, WorkspaceDraft } from '@/lib/settings-form';
import { repositoryOf } from '@/lib/settings-fork';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

// One workspace's base (handoff item 5): its colour and name, the field whose placeholder is the effective base, the hint for its fork
function BaseRow({ row, general, onChange }: { row: WorkspaceDraft; general: string; onChange(baseBranch: string): void }) {
  const remotes = useRemotes(row.path);
  const name = row.name.trim();
  const remote = baseRemote({ fork: row.fork });
  const { fork } = row;
  const hint = !fork ? t('settings.baseBranch.own')
    : fork.pr === 'fork' ? t('settings.baseBranch.fork', { fork: repositoryOf(remotes, 'origin') }) : t('settings.baseBranch.original', { original: repositoryOf(remotes, fork.remote) });
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)_2rem] items-start gap-3">
      <span className="flex items-center gap-2 pt-1.5 text-sm">
        <WorkspaceSquare name={name} color={row.color} />{name}
      </span>
      <div className="flex flex-col gap-1">
        <Input
          aria-label={t('settings.baseBranch.workspace', { workspace: name })} className="font-mono" value={row.baseBranch}
          placeholder={`${remote}/${general.trim() || 'HEAD'}`} onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-muted-foreground text-xs">{hint}</span>
      </div>
      <span />
    </div>
  );
}

/** branch base por workspace (#854): each workspace's own base over the general one, its placeholder and hint following its fork live. */
export function WorkspaceBases({ draft, onChange }: { draft: SettingsDraft; onChange(patch: Partial<SettingsDraft>): void }) {
  const set = (id: string, baseBranch: string): void => onChange({ workspaces: draft.workspaces.map((w) => (w.id === id ? { ...w, baseBranch } : w)) });
  return (
    <div className="flex flex-col gap-2">
      <Label>{t('settings.baseBranch.perWorkspace')}</Label>
      {draft.workspaces.map((row) => <BaseRow key={row.id} row={row} general={draft.baseBranch} onChange={(baseBranch) => set(row.id, baseBranch)} />)}
      <p className="text-muted-foreground text-xs">{t('settings.baseBranch.note')}</p>
    </div>
  );
}
