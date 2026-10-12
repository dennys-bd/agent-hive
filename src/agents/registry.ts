// The coding agents' runners (#924): node-side only. agents.ts keeps the facts the page reads too (labels, commands, planLimits, ranAgent);
// this module reads files and runs processes, so nothing the page imports may import it (vite build fails otherwise).
import { AGENTS } from '../agents.js';
import { AGENT_IDS, type AgentId, type PlanLimitsReport } from '../types.js';
import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import type { AgentRunner } from './runner.js';

/** A Record, so a new id in AGENT_IDS fails tsc until its runner exists. */
export const runners: Record<AgentId, AgentRunner> = { claude: claudeRunner, codex: codexRunner };

/** The Hive's own plan-limits readings (#929): every agent whose AGENTS entry says it has plan limits (#925), in AGENT_IDS order, one after the
 * other. A failing agent is listed with its reason, so one agent's failure never costs another's reading. `table` is the tests' seam. */
export async function planLimitsReading(table: Record<AgentId, Pick<AgentRunner, 'planLimits'>> = runners): Promise<PlanLimitsReport> {
  let report: PlanLimitsReport = { readings: [], failures: [] };
  for (const agent of AGENT_IDS.filter((id) => AGENTS[id].planLimits)) {
    try {
      const rateLimits = await table[agent].planLimits();
      if (rateLimits) report = { ...report, readings: [...report.readings, { agent, rateLimits }] };
    } catch (err) {
      report = { ...report, failures: [...report.failures, { agent, reason: err instanceof Error ? err.message : String(err) }] };
    }
  }
  return report;
}
