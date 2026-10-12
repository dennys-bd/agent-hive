// The coding agents' runners (#924): node-side only. agents.ts keeps the facts the page reads too (labels, commands, planLimits, ranAgent);
// this module reads files and runs processes, so nothing the page imports may import it (vite build fails otherwise).
import { AGENTS } from '../agents.js';
import { AGENT_IDS, type AgentId, type RateLimits } from '../types.js';
import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import type { AgentRunner } from './runner.js';

/** A Record, so a new id in AGENT_IDS fails tsc until its runner exists. */
export const runners: Record<AgentId, AgentRunner> = { claude: claudeRunner, codex: codexRunner };

/** The Hive's own plan-limits reading (#924): no run asks for it, so it is the runner of the agent whose AGENTS entry says it has plan limits
 * (#925). State.rateLimits holds one reading, which the header shows as that agent's; with none such, no reading. */
export function planLimitsReading(): Promise<RateLimits | undefined> {
  const agent = AGENT_IDS.find((id) => AGENTS[id].planLimits);
  return agent === undefined ? Promise.resolve(undefined) : runners[agent].planLimits();
}
