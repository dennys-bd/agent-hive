import { createContext } from 'react';
import type { AgentAvailability, AgentId } from '../../types.js';

/** The agents a menu offers (#482): boot's list (#516) without the ones the config disables. No config yet: every agent. */
export const offeredAgents = (agents: readonly AgentAvailability[], enabled: Partial<Record<AgentId, boolean>> | undefined): AgentAvailability[] =>
  agents.filter((a) => enabled?.[a.agent] !== false);

/** Each agent's default model (#482), null or absent = the CLI's own: App provides the saved config's, Settings its draft's, so every model field
 * names what an empty pick runs. */
export type AgentModels = Partial<Record<AgentId, string | null>>;
export const AgentModelsContext = createContext<AgentModels>({});
