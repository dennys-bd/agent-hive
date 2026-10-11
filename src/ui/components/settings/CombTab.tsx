import { ConnectionsGroup } from '@/components/settings/ConnectionsGroup';
import { SourcesGroup } from '@/components/settings/SourcesGroup';
import { StageEditor, type TransitionFocus } from '@/components/settings/StageEditor';
import { t } from '@/i18n';
import type { NewSource } from '@/lib/flow-sources';
import { commandFrom } from '@/lib/settings-commands';
import type { SettingsDraft } from '@/lib/settings-form';
import { transitionsKept } from '@/lib/settings-transitions';
import type { AgentAvailability, Command, GithubAuth, GithubAuthStatus, ProjectSummary } from '../../../types';

export interface CombTabProps {
  draft: SettingsDraft; options: Record<string, string[]>; githubProjects: Record<string, ProjectSummary[]>; github?: GithubAuthStatus;
  onChange(patch: Partial<SettingsDraft>): void; onConnectGithub(): void;
  onEditSource(id: string): void; onAddSource(added: NewSource): void; onOpenRules(): void;
  agents: readonly AgentAvailability[]; // found on boot (#516): each stage's agent select
  focus?: TransitionFocus; // #918: the transition a refused save selects
}

// Settings › fluxo's list page (#514): sources first (the local source, then the sources), then how the Hive reaches GitHub and the stages (#515 reworks those, #524 the local row).
export function CombTab({ draft, options, githubProjects, github, agents, focus, onChange, onConnectGithub, onEditSource, onAddSource, onOpenRules }: CombTabProps) {
  const githubSources = draft.sources.filter((b) => b.type === 'github');
  const hasGithub = githubSources.length > 0;
  const workspaceNames = draft.workspaces.map((p) => p.name.trim()).filter((n) => n !== '');
  // #755: the Comb's commands as a commands stage reads them, each with its lines per workspace; a row with no name yet is no command
  const commands: Command[] = draft.commands.filter((c) => c.name.trim() !== '').map((c) => commandFrom(c, draft.workspaces));

  return (
    <>
      <SourcesGroup
        sources={draft.sources} githubProjects={githubProjects} auth={draft.auth} workspaces={workspaceNames} prefix={draft.prefix}
        onEdit={onEditSource} onAdd={onAddSource} onPrefix={(prefix) => onChange({ prefix })}
        hiveSource={draft.hiveSource} createIn={draft.createIn} onHiveSource={(hiveSource) => onChange({ hiveSource })} onCreateIn={(createIn) => onChange({ createIn })}
      />
      {hasGithub && (
        <ConnectionsGroup
          auth={draft.auth} github={github} sourceNames={githubSources.map((b) => b.name.trim() || t('settings.source.unnamed'))}
          onConnect={onConnectGithub} onAuthChange={(auth: GithubAuth) => onChange({ auth })} onOpenQuota={onOpenRules}
        />
      )}
      {/* (#515, #134, #887) the stages card: StageEditor owns it, since its header's + etapa and + transição act on its selection */}
      <StageEditor
        stages={draft.stages} transitions={draft.transitions}
        sources={draft.sources.map((b, i) => ({ id: b.id, name: b.name.trim() || `#${i + 1}`, type: b.type, options: options[b.id] ?? [] }))}
        commands={commands} workspaces={workspaceNames}
        agents={agents} defaultAgent={draft.defaultAgent} focus={focus} onChange={({ stages, transitions }) => onChange({ stages, transitions: transitionsKept(transitions, stages) })}
      />
    </>
  );
}
