// Settings › execução's agents (#482): each agent's default model as typed and its switch, and the problems a save would meet, named before
// the round trip as parseConfig names them.
import { agentName } from '../../agents.js';
import { CLAUDE_MODEL } from '../../config-agent-args.js';
import { isLaunchModel } from '../../launch-pick.js';
import { AGENT_IDS, type AgentId } from '../../types.js';
import { t } from '../i18n.js';
import type { SettingsDraft, SettingsProblem } from './settings-form.js';
import { isAgentDraft, type StageDraft } from './settings-stages.js';

const perAgent = <T>(of: (id: AgentId) => T): Record<AgentId, T> => Object.fromEntries(AGENT_IDS.map((id) => [id, of(id)])) as Record<AgentId, T>;

export const agentModelsDraft = (saved?: Partial<Record<AgentId, string | null>>): Record<AgentId, string> => perAgent((id) => saved?.[id] ?? '');
export const agentModelsFrom = (draft: Record<AgentId, string>): Record<AgentId, string | null> => perAgent((id) => draft[id].trim() || null);
/** A first setup has every agent on (#482). */
export const agentEnabledDraft = (saved?: Partial<Record<AgentId, boolean>>): Record<AgentId, boolean> => perAgent((id) => saved?.[id] ?? true);

// The agents a stage sends (#482): its own when it runs an agent, its rows when it evaluates; a gate's leftover agent is never sent
const namedAgents = (stage: StageDraft): AgentId[] => [
  ...(isAgentDraft(stage) && stage.agent !== '' ? [stage.agent] : []),
  ...(stage.action === 'evaluate' ? [...stage.reviewers, stage.judge].map((row) => row.agent) : []),
];

/** The first agents problem (#482): a default model out of shape or a Claude model on codex (execution), then a stage that names a disabled
 * agent (flow, on that stage). */
export function agentsProblem(draft: Pick<SettingsDraft, 'agentModels' | 'agentEnabled' | 'stages'>): SettingsProblem | undefined {
  for (const agent of AGENT_IDS) {
    const model = draft.agentModels[agent].trim();
    if (model !== '' && !isLaunchModel(model)) return { section: 'execution', message: t('settings.agents.error.model', { agent: agentName(agent) }) };
    if (agent === 'codex' && CLAUDE_MODEL.test(model)) return { section: 'execution', message: t('settings.agents.error.claudeModel', { agent: agentName(agent), model }) };
  }
  const n = draft.stages.findIndex((stage) => namedAgents(stage).some((agent) => !draft.agentEnabled[agent]));
  const stage = draft.stages[n];
  const agent = stage === undefined ? undefined : namedAgents(stage).find((a) => !draft.agentEnabled[a]);
  return stage === undefined || agent === undefined ? undefined : { section: 'flow', stage: stage.id, message: t('settings.agents.error.stage', { n: n + 1, agent: agentName(agent) }) };
}
