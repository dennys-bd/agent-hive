import { AGENT_IDS, type AgentId } from '../../types.js';
import { splitArgs } from './new-session.js';

// Settings › execução's per-agent arguments (#482, replacing #924's one per line): one text per agent on one line, split on whitespace as the
// run fields' arguments are, so the card reads like the Start dialog. A saved item that holds a space comes back as several.

/** The draft's text per agent: the saved list joined with spaces; an agent with none gets an empty text. */
export const agentArgsDraft = (saved: Partial<Record<AgentId, readonly string[]>> | undefined): Record<AgentId, string> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, (saved?.[id] ?? []).join(' ')])) as Record<AgentId, string>;

/** What the form sends: each text split on whitespace; validateSettings refuses nothing here, any word is an argument. */
export const agentArgsFrom = (draft: Record<AgentId, string>): Record<AgentId, string[]> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, splitArgs(draft[id])])) as Record<AgentId, string[]>;
