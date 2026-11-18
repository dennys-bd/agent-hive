import { useEffect } from 'react';
import { asChoices, JiraNoSite, JiraReadNotice, JiraSelect, projectLabel } from '@/components/settings/JiraControls';
import { useJiraSites } from '@/hooks/use-jira-sites';
import type { NewJiraSource } from '@/hooks/use-new-jira-source';
import { t } from '@/i18n';
import type { JiraProject } from '@/lib/settings-jira';

interface NewJiraSourceFieldsProps { id: string; source: NewJiraSource; onPickProject(project: JiraProject): void; onOpenConnections(): void }

/** The dialog's Jira fields (#822): the connected sites, the site's projects, the read's state. The listing is read only once Jira is picked. */
export function NewJiraSourceFields({ id, source, onPickProject, onOpenConnections }: NewJiraSourceFieldsProps) {
  const { sites } = useJiraSites();
  const connected = (sites ?? []).filter((s) => s.state === 'connected').map((s) => s.site);
  const only = connected.length === 1 ? connected[0] : undefined;
  // one connected site is the only choice: picked for the user once the listing answers
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the listing's one site only; source is read fresh on that run
  useEffect(() => { if (only !== undefined && source.jira.site === '') source.pickSite(only); }, [only]);
  if (sites !== undefined && connected.length === 0) return <JiraNoSite onOpenConnections={onOpenConnections} />;
  return (
    <>
      <JiraSelect id={`${id}-site`} label="settings.source.jira.site" value={source.jira.site} choices={asChoices(connected)} placeholder="settings.source.jira.sitePlaceholder" onPick={source.pickSite} />
      <JiraSelect
        id={`${id}-jira-project`} label="settings.source.jira.project" value={source.jira.project} placeholder="settings.source.jira.projectPlaceholder"
        choices={source.projects.map((p) => ({ value: p.key, label: projectLabel(p) }))}
        onPick={(key) => { const picked = source.projects.find((p) => p.key === key); if (picked !== undefined) onPickProject(picked); }}
      />
      {source.isLoading && <p className="text-muted-foreground text-xs">{t('settings.source.jira.reading')}</p>}
      <JiraReadNotice error={source.error} onOpenConnections={onOpenConnections} />
    </>
  );
}
