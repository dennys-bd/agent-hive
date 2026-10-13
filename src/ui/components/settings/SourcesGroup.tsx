import { useId, useState } from 'react';
import { NewSourceDialog } from '@/components/settings/NewSourceDialog';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';
import { sourceSummary, type NewSource, TYPE_LABEL } from '@/lib/flow-sources';
import type { SourceDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import { DEFAULT_PREFIX, HIVE_SOURCE } from '../../../tasks';
import type { GithubAuth, ProjectSummary } from '../../../types';

interface SourcesGroupProps {
  sources: SourceDraft[]; githubProjects: Record<string, ProjectSummary[]>; auth: GithubAuth; workspaces: string[]; prefix: string;
  onEdit(id: string): void; onAdd(added: NewSource): void; onPrefix(prefix: string): void;
  hiveSource: boolean; createIn: string; onHiveSource(on: boolean): void; onCreateIn(createIn: string): void; // #846: createIn is HIVE_SOURCE or a source row's id
}

// The local row (#524): always first. Its editable cells are the task id prefix, moved here from the removed Comb card, and the switch (#846).
function LocalRow({ prefix, hiveSource, canTurnOff, onPrefix, onHiveSource }: { prefix: string; hiveSource: boolean; canTurnOff: boolean; onPrefix(prefix: string): void; onHiveSource(on: boolean): void }) {
  const [live, setLive] = useState(prefix);
  return (
    <div id={settingAnchor('settings.sources.local')} data-testid="local-row" className="grid grid-cols-[10rem_auto_1fr_auto] items-center gap-4 border-t px-5 py-3">
      <span className="truncate font-medium text-sm">{t('settings.sources.local')}</span>
      <Badge variant="outline">{t('settings.sources.type.local')}</Badge>
      <div id={settingAnchor('settings.prefix')} className="flex min-w-0 items-center gap-2">
        <span className="truncate text-muted-foreground text-xs">{t('settings.sources.local.hint')}</span>
        <Input
          className="w-24" aria-label={t('settings.prefix')} defaultValue={prefix}
          onChange={(e) => { onPrefix(e.target.value); setLive(e.target.value); }}
        />
        <span className="truncate text-muted-foreground text-xs">{t('settings.sources.local.ids', { prefix: live.trim() || DEFAULT_PREFIX })}</span>
      </div>
      <span className="flex items-center gap-2 text-muted-foreground text-xs">
        {!canTurnOff && <span>{t('settings.sources.local.needsSource')}</span>}
        {/* #846: off only with a source; a Comb left off with none can still turn it back on */}
        <Switch checked={hiveSource} disabled={!canTurnOff && hiveSource} aria-label={t('settings.sources.local.switch')} onCheckedChange={onHiveSource} />
      </span>
    </div>
  );
}

// #846: the default destination of new tasks: hive while it is on, then every source with a repository; a source's value is its row id
function CreateInRow({ sources, hiveSource, createIn, onCreateIn }: Pick<SourcesGroupProps, 'sources' | 'hiveSource' | 'createIn' | 'onCreateIn'>) {
  const id = useId();
  return (
    <div id={settingAnchor('settings.sources.createIn')} className="flex items-center gap-4 border-t px-5 py-3">
      <Label htmlFor={id} className="w-40 shrink-0">{t('settings.sources.createIn')}</Label>
      <Select value={createIn} onValueChange={onCreateIn}>
        <SelectTrigger id={id} className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          {hiveSource && <SelectItem value={HIVE_SOURCE}>{HIVE_SOURCE}</SelectItem>}
          {sources.filter((b) => b.repository !== '').map((b) => <SelectItem key={b.id} value={b.id}>{b.name.trim() || t('settings.source.unnamed')}</SelectItem>)}
        </SelectContent>
      </Select>
      <span className="truncate text-muted-foreground text-xs">{t('settings.sources.createIn.hint')}</span>
    </div>
  );
}

// The loaded project's title for a row's summary (#514): none until GET /settings/projects answers for its owner.
const titleOf = (source: SourceDraft, loaded: ProjectSummary[]): string | undefined => loaded.find((p) => String(p.number) === source.number)?.title;

/** sources (#514): the local source, then one row per source, its type badge and one-line summary, `editar →` to its detail page,
 * `+ source` to the new-source dialog (#524). */
export function SourcesGroup({ sources, githubProjects, auth, workspaces, prefix, hiveSource, createIn, onEdit, onAdd, onPrefix, onHiveSource, onCreateIn }: SourcesGroupProps) {
  const [open, setOpen] = useState(false);
  // hive off while it is the destination would leave the Select on a value that is no longer an option: the first source with a repository takes over
  const turnHive = (on: boolean): void => {
    onHiveSource(on);
    const next = sources.find((b) => b.repository !== '');
    if (!on && createIn === HIVE_SOURCE && next !== undefined) onCreateIn(next.id);
  };
  return (
    <SettingsGroup
      title="settings.sources" hint="settings.sources.hint" flush
      action={<Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>{t('settings.sources.add')}</Button>}
    >
      <CreateInRow sources={sources} hiveSource={hiveSource} createIn={createIn} onCreateIn={onCreateIn} />
      <LocalRow prefix={prefix} hiveSource={hiveSource} canTurnOff={sources.length > 0} onPrefix={onPrefix} onHiveSource={turnHive} />
      {sources.length === 0 && <p className="px-5 py-3 text-muted-foreground text-xs">{t('settings.sources.none')}</p>}
      {sources.map((b) => {
        const name = b.name.trim() || t('settings.source.unnamed');
        return (
          <div key={b.id} data-testid="source-row" className="grid grid-cols-[10rem_auto_1fr_auto] items-center gap-4 border-t px-5 py-3">
            <span className="truncate font-medium text-sm">{name}</span>
            <Badge variant="outline">{t(TYPE_LABEL[b.type])}</Badge>
            <span className="truncate text-muted-foreground text-xs">{sourceSummary(b, titleOf(b, githubProjects[b.id] ?? []))}</span>
            <button type="button" className="text-review text-xs" aria-label={t('settings.sources.editSource', { source: name })} onClick={() => onEdit(b.id)}>
              {t('settings.sources.edit')}
            </button>
          </div>
        );
      })}
      <NewSourceDialog open={open} onOpenChange={setOpen} auth={auth} workspaces={workspaces} takenNames={sources.map((b) => b.name.trim())} onAdd={(added) => { setOpen(false); onAdd(added); }} />
    </SettingsGroup>
  );
}
