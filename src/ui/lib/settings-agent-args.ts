import { AGENT_IDS, type AgentId } from '../../types.js';

// Settings › Execution's per-agent arguments (#924): one text per agent, one argument per line, so a value with spaces never needs shell
// quoting and stays one argument.

/** The draft's text per agent: the saved list, one argument per line; an agent with none gets an empty text. */
export const agentArgsDraft = (saved: Partial<Record<AgentId, readonly string[]>> | undefined): Record<AgentId, string> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, (saved?.[id] ?? []).join('\n')])) as Record<AgentId, string>;

/** What the form sends: each non-blank line one argument, kept as typed; validateSettings refuses nothing here, any line is an argument. */
export const agentArgsFrom = (draft: Record<AgentId, string>): Record<AgentId, string[]> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, draft[id].split(/\r?\n/).filter((line) => line.trim() !== '')])) as Record<AgentId, string[]>;
