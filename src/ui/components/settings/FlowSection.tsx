import { SourceDetail } from '@/components/settings/SourceDetail';
import { CombTab } from '@/components/settings/CombTab';
import type { TransitionFocus } from '@/components/settings/StageEditor';
import { CONNECTIONS_ANCHOR } from '@/components/settings/ConnectionsGroup';
import { needsGithubToken, type NewSource } from '@/lib/flow-sources';
import type { SourceDraft, SettingsDraft } from '@/lib/settings-form';
import type { AgentAvailability, FilterOptions, GithubAuthStatus, ProjectSummary } from '../../../types';

export interface FlowProps {
  focus?: TransitionFocus;
  options: Record<string, string[]>; githubProjects: Record<string, ProjectSummary[]>; github?: GithubAuthStatus; filterOptions: Record<string, FilterOptions>;
  onConnectGithub(): void; onLoadProjects(source: SourceDraft): void; onLoadColumns(source: SourceDraft): void;
  onOpenSource(id?: string): void; onAddSource(added: NewSource): void; onOpenRules(): void;
}
interface FlowSectionProps { draft: SettingsDraft; source?: SourceDraft; flow: FlowProps; agents: readonly AgentAvailability[]; onChange(patch: Partial<SettingsDraft>): void }

// Settings › fluxo (#514): the list, or one source's detail when the view names a row. Every edit is a draft edit; the page saves.
export function FlowSection({ draft, source, flow, agents, onChange }: FlowSectionProps) {
  if (!source) {
    return (
      <CombTab
        draft={draft} options={flow.options} githubProjects={flow.githubProjects} github={flow.github} agents={agents} focus={flow.focus} onChange={onChange}
        onConnectGithub={flow.onConnectGithub} onEditSource={flow.onOpenSource} onAddSource={flow.onAddSource} onOpenRules={flow.onOpenRules}
      />
    );
  }
  const workspaces = draft.workspaces.map((p) => p.name.trim()).filter((n) => n !== '');
  return (
    <SourceDetail
      source={source} workspaces={workspaces} githubProjects={flow.githubProjects[source.id] ?? []} needsToken={needsGithubToken(draft.auth, flow.github)}
      epics={draft.epics} auth={draft.auth} filterOptions={flow.filterOptions[source.id]}
      onChange={(patch) => onChange({ sources: draft.sources.map((b) => (b.id === source.id ? { ...b, ...patch } : b)) })}
      onRemove={() => { onChange({ sources: draft.sources.filter((b) => b.id !== source.id) }); flow.onOpenSource(undefined); }}
      onLoadProjects={() => flow.onLoadProjects(source)}
      onLoadColumns={(number) => flow.onLoadColumns(number === undefined ? source : { ...source, number })}
      onEpicsChange={(epics) => onChange({ epics })}
      onOpenList={() => {
        flow.onOpenSource(undefined);
        // the list renders on this click's commit, before the next frame: then the group exists to scroll to
        requestAnimationFrame(() => document.getElementById(CONNECTIONS_ANCHOR)?.scrollIntoView({ block: 'start' }));
      }}
    />
  );
}
