import { agentOf } from './agents.js';
import { AGENT_IDS, type AgentId, type Stage } from './types.js';

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

/** A Claude alias, with or without its 1M context, or a claude- id (#927): Codex maps none of them, and its API answers a 400 with no Stop
 * (finding §4, §11). Exported for the open routes, which refuse it on a Codex session (#257). */
export const CLAUDE_MODEL = /^(?:(?:fable|opus|sonnet|haiku)(?:\[1m\])?|claude-.*)$/;

/** #927: a stage whose agent (its own, else the default) is codex and whose model is Claude's is refused by field. The Hive has no list of
 * Codex models to check against otherwise. parseConfig runs it once defaultAgent is parsed, as checkResumedAgents. */
export function checkStageModels(stages: readonly Stage[], defaultAgent: AgentId): void {
  stages.forEach((stage, i) => {
    if (stage.model === undefined || agentOf(stage, { defaultAgent }) !== 'codex' || !CLAUDE_MODEL.test(stage.model)) return;
    throw new Error(`${FILE}: "comb.stages[${i}].model" "${stage.model}" is a Claude model; a codex stage needs a Codex model name`);
  });
}
