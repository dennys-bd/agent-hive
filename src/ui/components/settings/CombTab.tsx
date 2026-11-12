import { type ComponentProps, useEffect, useState } from 'react';
import { ConnectionsGroup } from '@/components/settings/ConnectionsGroup';
import { FlowRow } from '@/components/settings/FlowRow';
import { SourcesGroup } from '@/components/settings/SourcesGroup';
import { StageEditor, type StageFocus, type TransitionFocus } from '@/components/settings/StageEditor';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';
import type { NewSource } from '@/lib/flow-sources';
import { commandFrom } from '@/lib/settings-commands';
import type { SettingsDraft } from '@/lib/settings-form';
import { scopedFlow, withFlowEdit, withNewFlow, withoutFlow } from '@/lib/settings-flows';
import { flowOfStage } from '@/lib/settings-transitions';
import { stageNameClash } from '@/lib/settings-stages';
import type { AgentAvailability, Command, GithubAuth, GithubAuthStatus, ProjectSummary } from '../../../types';

export interface CombTabProps {
  draft: SettingsDraft; options: Record<string, string[]>; githubProjects: Record<string, ProjectSummary[]>; github?: GithubAuthStatus;
  onChange(patch: Partial<SettingsDraft>): void; onConnectGithub(): void;
  onEditSource(id: string): void; onAddSource(added: NewSource): void; onOpenRules(): void;
  agents: readonly AgentAvailability[]; // found on boot (#516): each stage's agent select
  launchWorkspace?: string; // #710: the config's first workspace, whose lists the run fields offer
  focus?: TransitionFocus; // #918: the transition a refused save selects
  stage?: StageFocus; // #689: the stage the Settings search opens
  newFlow?: boolean; // #565: open with the + fluxo form shown
  flowTasks(id: string): number; // #565: a draft flow's saved tasks
}

// Settings › fluxo's list page (#514): sources first (the local source, then the sources), then how the Hive reaches GitHub and the stages (#515 reworks those, #524 the local row).
export function CombTab({ draft, options, githubProjects, github, agents, launchWorkspace, focus, stage, newFlow, flowTasks, onChange, onConnectGithub, onEditSource, onAddSource, onOpenRules }: CombTabProps) {
  const launchOptions = useLaunchOptions(launchWorkspace);
  const githubSources = draft.sources.filter((b) => b.type === 'github');
  const hasGithub = githubSources.length > 0;
  const workspaceNames = draft.workspaces.map((p) => p.name.trim()).filter((n) => n !== '');
  // #755: the Comb's commands as a commands stage reads them, each with its lines per workspace; a row with no name yet is no command
  const commands: Command[] = draft.commands.filter((c) => c.name.trim() !== '').map((c) => commandFrom(c, draft.workspaces));

  return (
    <>
      <SourcesGroup
        sources={draft.sources} scope={draft} githubProjects={githubProjects} auth={draft.auth} workspaces={workspaceNames} prefix={draft.prefix}
        onEdit={onEditSource} onAdd={onAddSource} onPrefix={(prefix) => onChange({ prefix })}
        hiveSource={draft.hiveSource} createIn={draft.createIn} onHiveSource={(hiveSource) => onChange({ hiveSource })} onCreateIn={(createIn) => onChange({ createIn })}
      />
      {hasGithub && (
        <ConnectionsGroup
          auth={draft.auth} github={github} sourceNames={githubSources.map((b) => b.name.trim() || t('settings.source.unnamed'))}
          onConnect={onConnectGithub} onAuthChange={(auth: GithubAuth) => onChange({ auth })} onOpenQuota={onOpenRules}
        />
      )}
      {/* (#515, #134, #887, #565) the stages card, over the open flow: StageEditor owns it, since its header's + etapa and + transição act on its selection */}
      <FlowStages
        draft={draft} newFlow={newFlow} flowTasks={flowTasks} stage={stage} focus={focus} onChange={onChange}
        sources={draft.sources.map((b, i) => ({ id: b.id, name: b.name.trim() || `#${i + 1}`, type: b.type, options: options[b.id] ?? [] }))}
        commands={commands} workspaces={workspaceNames} agents={agents} launchOptions={launchOptions}
      />
    </>
  );
}

// #565: the open flow, by draft id: the searched stage's flow, else the first. A refused save's stage or transition (#918) opens its flow; a flow a
// revert took away reads as the first
function useOpenFlow(draft: SettingsDraft, stage?: StageFocus, focus?: TransitionFocus): [string, (id: string) => void] {
  const [open, setOpen] = useState(() => flowOfStage(draft.stages, stage?.id) ?? draft.flows[0]?.id ?? '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on n alone, as StageEditor's selection is
  useEffect(() => { const flow = flowOfStage(draft.stages, stage?.id); if (flow !== undefined) setOpen(flow); }, [stage?.n]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on n alone, as StageEditor's selection is
  useEffect(() => {
    const flow = flowOfStage(draft.stages, draft.transitions.find((d) => d.id === focus?.transition)?.from);
    if (flow !== undefined) setOpen(flow);
  }, [focus?.n]);
  return [draft.flows.some((f) => f.id === open) ? open : (draft.flows[0]?.id ?? ''), setOpen];
}

type EditorProps = Pick<ComponentProps<typeof StageEditor>, 'sources' | 'commands' | 'workspaces' | 'agents' | 'launchOptions'>;
interface FlowStagesProps extends EditorProps { draft: SettingsDraft; newFlow?: boolean; flowTasks(id: string): number; stage?: StageFocus; focus?: TransitionFocus; onChange(patch: Partial<SettingsDraft>): void }

// The etapas card over the open flow (#565): StageEditor sees only its stages and transitions, keyed on it so its selection starts on the flow's
// own stage; its changes go back into the flat lists in flow order. The + fluxo form's state lives here, since the keyed card remounts its row
function FlowStages({ draft, newFlow, flowTasks, stage, focus, onChange, ...editor }: FlowStagesProps) {
  const [open, setOpen] = useOpenFlow(draft, stage, focus);
  const [isAdding, setAdding] = useState(newFlow === true);
  const create = (name: string): void => { const { id, patch } = withNewFlow(draft, name, draft.defaultAgent); onChange(patch); setOpen(id); };
  const remove = (): void => { const next = withoutFlow(draft, open); onChange(next); setOpen(next.flows[0]?.id ?? ''); };
  const rename = (name: string): void => onChange({ flows: draft.flows.map((f) => (f.id === open ? { ...f, name } : f)) });
  const scope = scopedFlow(draft, open);
  const row = <FlowRow flows={draft.flows} open={open} isAdding={isAdding} taskCount={flowTasks(open)} onOpen={setOpen} onAdding={setAdding} onCreate={create} onRename={rename} onRemove={remove} />;
  return (
    <StageEditor
      key={open} flow={open} comb={draft} flowRow={row} stages={scope.stages} transitions={scope.transitions} focus={focus} stage={stage}
      clashOf={(id) => stageNameClash(draft.stages, draft.flows, id)} defaultAgent={draft.defaultAgent} {...editor}
      onChange={(next) => onChange(withFlowEdit(draft, open, next))}
    />
  );
}
