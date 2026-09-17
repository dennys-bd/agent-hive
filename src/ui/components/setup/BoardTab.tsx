import { ColumnEditor } from '@/components/setup/ColumnEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { QUOTA_RESERVE } from '@/lib/usage';
import type { SetupDraft } from '@/lib/setup-form';
import type { BoardConfig, BoardQuota, EpicsMode, ProjectSummary } from '../../../types';

interface BoardTabProps {
  draft: SetupDraft; options: string[]; projects: ProjectSummary[]; quota?: BoardQuota; locale: string;
  onChange(patch: Partial<SetupDraft>): void; onLoadProjects(): void;
  /** Loads columns for `project` when given (the Select passes its new value directly, never through the `draft` prop,
   * which would still read the project just left — see onChange({ project }) below); omitted, it reloads the current draft. */
  onLoadColumns(project?: string): void;
}

export function BoardTab({ draft, options, projects, quota, locale, onChange, onLoadProjects, onLoadColumns }: BoardTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="setup-board-type">{t('setup.boardType')}</Label>
        <Select value={draft.boardType} onValueChange={(v) => onChange({ boardType: v as BoardConfig['type'] })}>
          <SelectTrigger id="setup-board-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="github">{t('setup.boardType.github')}</SelectItem>
            <SelectItem value="markdown">{t('setup.boardType.markdown')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.boardType === 'github' ? (
        <>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="setup-owner">{t('setup.owner')}</Label>
              <Input id="setup-owner" defaultValue={draft.owner} onChange={(e) => onChange({ owner: e.target.value })} />
            </div>
            <Button type="button" variant="outline" onClick={onLoadProjects}>{t('setup.load')}</Button>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="setup-project">{t('setup.project')}</Label>
            <Select value={draft.project} onValueChange={(v) => { onChange({ project: v }); onLoadColumns(v); }}>
              <SelectTrigger id="setup-project"><SelectValue placeholder={t('setup.projectPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {projects.map((p) => <SelectItem key={p.number} value={String(p.number)}>{`#${p.number} ${p.title}`}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="setup-epics">{t('setup.epics')}</Label>
            <Select value={draft.epics} onValueChange={(v) => onChange({ epics: v as EpicsMode })}>
              <SelectTrigger id="setup-epics"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ignore">{t('setup.epics.ignore')}</SelectItem>
                <SelectItem value="queue">{t('setup.epics.queue')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {quota && (
            <p className={quota.remaining < QUOTA_RESERVE ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {`GitHub ${quota.remaining.toLocaleString(locale)}/${quota.limit.toLocaleString(locale)}`}
            </p>
          )}
        </>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="setup-md-path">{t('setup.markdownPath')}</Label>
            <Input id="setup-md-path" defaultValue={draft.markdownPath} onChange={(e) => onChange({ markdownPath: e.target.value })} />
          </div>
          <Button type="button" variant="outline" onClick={() => onLoadColumns()}>{t('setup.load')}</Button>
        </div>
      )}
      {draft.boardType === 'markdown' && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the dictionary is code, not input
        <p className="text-muted-foreground text-xs" dangerouslySetInnerHTML={{ __html: t('setup.markdownHint') }} />
      )}
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">{t('setup.columns')}</h3>
        <p className="text-muted-foreground text-xs">{t('setup.columns.loadHint')}</p>
        <ColumnEditor columns={draft.columns} options={options} onChange={(columns) => onChange({ columns })} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the dictionary is code, not input */}
        <p className="text-muted-foreground text-xs" dangerouslySetInnerHTML={{ __html: t('setup.columns.hint') }} />
      </div>
    </div>
  );
}
