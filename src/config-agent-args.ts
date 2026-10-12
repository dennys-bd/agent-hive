import { AGENT_IDS, type AgentId } from './types.js';

// agentArgs in hive.config.json (#924), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE, repeated here as
// config-epics.ts does, since config.ts imports this file.
const FILE = 'hive.config.json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string');

/** Required, no default (#924): one list of strings per agent of AGENT_IDS and no other key. A file from before the key is migrated in
 * memory (migrateAgentArgs), so only a hand edit or an API caller reaches a refusal. */
export function parseAgentArgs(value: unknown): Record<AgentId, string[]> {
  const raw = isRecord(value) ? value : {};
  const stray = Object.keys(raw).find((key) => !(AGENT_IDS as readonly string[]).includes(key));
  if (stray !== undefined) throw new Error(`${FILE}: "agentArgs" has an unknown agent "${stray}"`);
  const listOf = (id: AgentId): string[] => {
    const list = raw[id];
    if (!isStringList(list)) throw new Error(`${FILE}: "agentArgs.${id}" must be an array of strings`);
    return [...list];
  };
  return Object.fromEntries(AGENT_IDS.map((id) => [id, listOf(id)])) as Record<AgentId, string[]>;
}
