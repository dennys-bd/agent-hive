// The coding agents' runners (#924): node-side only. agents.ts keeps the facts the page reads too (labels, commands, planLimits, ranAgent);
// this module reads files and runs processes, so nothing the page imports may import it (vite build fails otherwise).
import { planLimitAgents } from '../agents.js';
import type { AccountEnvDeps } from '../account-env.js';
import type { AgentId, PlanLimitsReport } from '../types.js';
import { claudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { copilotRunner } from './copilot.js';
import type { AgentRunner } from './runner.js';

/** A Record, so a new id in AGENT_IDS fails tsc until its runner exists. */
export const runners: Record<AgentId, AgentRunner> = { claude: claudeRunner, codex: codexRunner, copilot: copilotRunner };

/** The Hive's own plan-limits readings (#929): the agents `planLimitAgents(agents)` names (#223), in AGENT_IDS order, one after the other.
 * A failing agent is listed with its reason, so one agent's failure never costs another's reading. `accounts` is the run seam's deps (#962),
 * handed to every runner. `table` is the tests' seam. */
export async function planLimitsReading(agents: readonly AgentId[] | undefined, accounts: AccountEnvDeps, table: Record<AgentId, Pick<AgentRunner, 'planLimits'>> = runners): Promise<PlanLimitsReport> {
  let report: PlanLimitsReport = { readings: [], failures: [] };
  for (const agent of planLimitAgents(agents)) {
    try {
      const rateLimits = await table[agent].planLimits({ accounts });
      if (rateLimits) report = { ...report, readings: [...report.readings, { agent, rateLimits }] };
    } catch (err) {
      report = { ...report, failures: [...report.failures, { agent, reason: err instanceof Error ? err.message : String(err) }] };
    }
  }
  return report;
}
