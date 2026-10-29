import { agentOf } from './agents.js';
import { isLaunchModel } from './launch-pick.js';
import { AGENT_IDS, type AgentId, type Stage } from './types.js';

// agentArgs, agentModels and agentEnabled in hive.config.json (#924, #482), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE, repeated here as
// config-epics.ts does, since config.ts imports this file.
const FILE = 'hive.config.json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string');

// One value per agent of AGENT_IDS and no other key (#924, #482): `read` checks each, by its field
function perAgent<T>(value: unknown, key: string, read: (raw: unknown, field: string) => T): Record<AgentId, T> {
  const raw = isRecord(value) ? value : {};
  const stray = Object.keys(raw).find((k) => !(AGENT_IDS as readonly string[]).includes(k));
  if (stray !== undefined) throw new Error(`${FILE}: "${key}" has an unknown agent "${stray}"`);
  return Object.fromEntries(AGENT_IDS.map((id) => [id, read(raw[id], `${key}.${id}`)])) as Record<AgentId, T>;
}

/** Required, no default (#924): one list of strings per agent of AGENT_IDS and no other key. A file from before the key is migrated in
 * memory (migrateAgentArgs), so only a hand edit or an API caller reaches a refusal. */
export const parseAgentArgs = (value: unknown): Record<AgentId, string[]> => perAgent(value, 'agentArgs', (list, field) => {
  if (!isStringList(list)) throw new Error(`${FILE}: "${field}" must be an array of strings`);
  return [...list];
});

/** A Claude alias, with or without its 1M context, or a claude- id (#927): Codex maps none of them, and its API answers a 400 with no Stop
 * (finding §4, §11). Exported for the open routes, which refuse it on a Codex session (#257). */
export const CLAUDE_MODEL = /^(?:(?:fable|opus|sonnet|haiku)(?:\[1m\])?|claude-.*)$/;

/** #482: required, every agent: null (the CLI's own default) or a name the open routes would take (#257). Codex's may not be a Claude model
 * (#927): the Hive has no Codex list to check against otherwise. */
export const parseAgentModels = (value: unknown): Record<AgentId, string | null> => perAgent(value, 'agentModels', (model, field) => {
  if (model !== null && !isLaunchModel(model)) throw new Error(`${FILE}: "${field}" must be null or a model name`);
  if (field === 'agentModels.codex' && model !== null && CLAUDE_MODEL.test(model)) throw new Error(`${FILE}: "${field}" "${model}" is a Claude model; codex needs a Codex model name`);
  return model;
});

/** #482: required, every agent, true or false. */
export const parseAgentEnabled = (value: unknown): Record<AgentId, boolean> => perAgent(value, 'agentEnabled', (on, field) => {
  if (typeof on !== 'boolean') throw new Error(`${FILE}: "${field}" must be true or false`);
  return on;
});

/** #482: the default agent is always enabled, so no run is left without one; a stage's own agent and an evaluation row's must be enabled,
 * so no saved stage fails later. A stage with no own agent runs the default. parseConfig runs it once defaultAgent is parsed. */
export function checkEnabledAgents(stages: readonly Stage[], defaultAgent: AgentId, enabled: Record<AgentId, boolean>): void {
  if (!enabled[defaultAgent]) throw new Error(`${FILE}: "agentEnabled.${defaultAgent}" cannot be false: ${defaultAgent} is the default agent`);
  stages.forEach((stage, i) => {
    const named: [string, AgentId | undefined][] = [
      [`comb.stages[${i}].agent`, stage.agent],
      ...(stage.reviewers ?? []).map((row, j): [string, AgentId] => [`comb.stages[${i}].reviewers[${j}].agent`, row.agent]),
      [`comb.stages[${i}].judge.agent`, stage.judge?.agent],
    ];
    const off = named.find(([, agent]) => agent !== undefined && !enabled[agent]);
    if (off !== undefined) throw new Error(`${FILE}: "${off[0]}" names ${off[1]}, which "agentEnabled" turns off`);
  });
}

/** #927: a stage whose agent (its own, else the default) is codex and whose model is Claude's is refused by field. The Hive has no list of
 * Codex models to check against otherwise. parseConfig runs it once defaultAgent is parsed, as checkResumedAgents. */
export function checkStageModels(stages: readonly Stage[], defaultAgent: AgentId): void {
  stages.forEach((stage, i) => {
    if (stage.model === undefined || agentOf(stage, { defaultAgent }) !== 'codex' || !CLAUDE_MODEL.test(stage.model)) return;
    throw new Error(`${FILE}: "comb.stages[${i}].model" "${stage.model}" is a Claude model; a codex stage needs a Codex model name`);
  });
}
