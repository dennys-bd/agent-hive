import { SourceDetail, sourceEntries } from '@/components/settings/SourceDetail';
import { CombTab } from '@/components/settings/CombTab';
import type { StageFocus, TransitionFocus } from '@/components/settings/StageEditor';
import { stageEntries } from '@/components/settings/StageDetail';
import { CONNECTIONS_ANCHOR } from '@/components/settings/ConnectionsGroup';
import { needsGithubToken, type NewSource } from '@/lib/flow-sources';
import type { SourceDraft, SettingsDraft } from '@/lib/settings-form';
import { cardEntries, type SettingEntry, settingEntry } from '@/lib/settings-search';
import type { AgentAvailability, FilterOptions, GithubAuthStatus, ProjectSummary } from '../../../types';

export interface FlowProps {
  focus?: TransitionFocus;
  stage?: StageFocus; // #689: the stage the Settings search opens
  options: Record<string, string[]>; githubProjects: Record<string, ProjectSummary[]>; github?: GithubAuthStatus; filterOptions: Record<string, FilterOptions>;
  onConnectGithub(): void; onLoadProjects(source: SourceDraft): void; onLoadColumns(source: SourceDraft): void;
  onOpenSource(id?: string): void; onAddSource(added: NewSource): void; onOpenRules(): void;
}
interface FlowSectionProps { draft: SettingsDraft; source?: SourceDraft; flow: FlowProps; agents: readonly AgentAvailability[]; launchWorkspace?: string; onChange(patch: Partial<SettingsDraft>): void }

// Settings › fluxo (#514): the list, or one source's detail when the view names a row. Every edit is a draft edit; the page saves.
export function FlowSection({ draft, source, flow, agents, launchWorkspace, onChange }: FlowSectionProps) {
  if (!source) {
    return (
      <CombTab
        draft={draft} options={flow.options} githubProjects={flow.githubProjects} github={flow.github} agents={agents} launchWorkspace={launchWorkspace} focus={flow.focus} stage={flow.stage} onChange={onChange}
        onConnectGithub={flow.onConnectGithub} onEditSource={flow.onOpenSource} onAddSource={flow.onAddSource} onOpenRules={flow.onOpenRules}
      />
    );
  }
  const workspaces = draft.workspaces.map((p) => p.name.trim()).filter((n) => n !== '');
  return (
    <SourceDetail
      key={source.id} source={source} stages={draft.stages} workspaces={workspaces} githubProjects={flow.githubProjects[source.id] ?? []} needsToken={needsGithubToken(draft.auth, flow.github)}
      auth={draft.auth} filterOptions={flow.filterOptions[source.id]}
      onChange={(patch) => onChange({ sources: draft.sources.map((b) => (b.id === source.id ? { ...b, ...patch } : b)) })}
      onRemove={() => { onChange({ sources: draft.sources.filter((b) => b.id !== source.id) }); flow.onOpenSource(undefined); }}
      onLoadProjects={() => flow.onLoadProjects(source)}
      onLoadColumns={(number) => flow.onLoadColumns(number === undefined ? source : { ...source, number })}
      onOpenList={() => {
        flow.onOpenSource(undefined);
        // the list renders on this click's commit, before the next frame: then the group exists to scroll to
        requestAnimationFrame(() => document.getElementById(CONNECTIONS_ANCHOR)?.scrollIntoView({ block: 'start' }));
      }}
    />
  );
}

/** Settings › fluxo's entries of the Settings search (#689): the sources card, the connections and stages cards, then each source's and stage's own. */
export function searchEntries(draft: SettingsDraft): SettingEntry[] {
  return [
    ...cardEntries('flow', 'settings.sources', ['settings.sources.createIn', 'settings.sources.local', 'settings.prefix']),
    ...(draft.sources.some((b) => b.type === 'github') ? [settingEntry('settings.connections', 'flow')] : []),
    settingEntry('settings.stages', 'flow'),
    ...draft.sources.flatMap(sourceEntries),
    ...draft.stages.flatMap(stageEntries),
  ];
}
