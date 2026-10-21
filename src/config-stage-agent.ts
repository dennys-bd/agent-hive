import { isSpecializedAgent } from './launch-pick.js';
import { SKILL_NAME } from './stage-agent.js';
import type { Stage } from './types.js';

// A stage's skill and specialized agent in hive.config.json (#710), out of config.ts, which is over 400 lines. The prefix is config.ts's
// CONFIG_FILE written out, as config-transitions.ts does: config.ts imports this file.
const FILE = 'hive.config.json';

function fail(field: string, what: string): never {
  throw new Error(`${FILE}: "${field}" ${what}`);
}

/** Whether a raw stage runs an agent (#710): a skill stage, or no action and a prompt. What config.ts's combinations read before the stage exists. */
export const runsAgentRaw = (raw: Record<string, unknown>): boolean => raw.action === 'skill' || (raw.action === undefined && raw.prompt !== undefined);

/** Whether a raw stage's action is one the Hive runs itself (#710): any action but skill, which runs an agent and takes a prompt stage's keys. */
export const hiveActionRaw = (raw: Record<string, unknown>): boolean => raw.action !== undefined && raw.action !== 'skill';

const requireSkill = (value: unknown, field: string): string =>
  (typeof value === 'string' && SKILL_NAME.test(value) ? value : fail(field, 'must be a Hive skill\'s name: lowercase letters, digits and hyphens'));

/** skill (#710): required with action skill, one folder name of the plugin's skills/, refused with any other action or none. specializedAgent:
 * hive:<name>, on a stage that runs an agent only. Whether the workspace's plugin has either is the run's to check (spec decision 5). */
export function parseStageAgent(raw: Record<string, unknown>, field: string): Pick<Stage, 'skill' | 'specializedAgent'> {
  if (raw.action !== 'skill' && raw.skill !== undefined) fail(`${field}.skill`, 'needs "action": "skill"');
  const skill = raw.action === 'skill' ? { skill: requireSkill(raw.skill, `${field}.skill`) } : {};
  if (raw.specializedAgent === undefined) return skill;
  if (!runsAgentRaw(raw)) fail(`${field}.specializedAgent`, 'needs a stage that runs an agent: a "prompt" or "action": "skill"');
  if (!isSpecializedAgent(raw.specializedAgent)) fail(`${field}.specializedAgent`, 'must be hive:<name>, lowercase letters, digits and hyphens');
  return { ...skill, specializedAgent: raw.specializedAgent };
}
