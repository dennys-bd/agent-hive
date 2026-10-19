// The `reviewer` key of hive.config.json (#328), out of config.ts, which is over 400 lines. Optional: a file without it, and each field it
// leaves out, takes REVIEWER_DEFAULTS; an unknown field is dropped. Whether `version` is a version of the reviewer is checked when a review
// runs, not here: the store is on disk, and deleting a version must not stop the Hive from booting. The problem comes back as a sentence;
// config.ts adds the file's name.
import { isVersionName } from './custom-versions.js';
import { isLaunchModel } from './launch-pick.js';
import { AGENT_IDS, type AgentId, REVIEW_WHEN, REVIEWER_DEFAULTS, type ReviewerConfig, type ReviewWhen } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHAPE = '"reviewer" must be an object with on, when, agent, model, version';

/** The parsed key, or the first problem as a sentence without the file's name. */
export function parseReviewer(raw: unknown): ReviewerConfig | string {
  if (raw === undefined) return REVIEWER_DEFAULTS;
  if (!isRecord(raw)) return SHAPE;
  const { on, when, agent, model, version }: Record<string, unknown> = { ...REVIEWER_DEFAULTS, ...raw }; // JSON has no undefined: a key is there or not
  if (typeof on !== 'boolean') return '"reviewer.on" must be true or false';
  if (!REVIEW_WHEN.includes(when as ReviewWhen)) return `"reviewer.when" must be one of: ${REVIEW_WHEN.join(', ')}`;
  if (agent !== null && !AGENT_IDS.includes(agent as AgentId)) return `"reviewer.agent" must be one of: ${AGENT_IDS.join(', ')}`; // requireAgent's words
  if (model !== null && !isLaunchModel(model)) return '"reviewer.model" must be null or a model name'; // never a leading '-': it reaches an argv
  if (version !== null && !isVersionName(version)) return '"reviewer.version" must be null or a version name';
  return { on, when: when as ReviewWhen, agent: agent as AgentId | null, model: model as string | null, version: version as string | null };
}
