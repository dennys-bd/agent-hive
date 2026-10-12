import type { Express, Request, Response } from 'express';
import type { TaskRouteDeps } from './server-tasks.js';
import { knownAgent } from './agents.js';
import { AGENT_IDS, type AgentId, RULE_SOURCES } from './types.js';
import { isDisableUntil, isPercent, isRuleSource } from './usage-rules.js';

const HTTP_BAD_REQUEST = 400;
const RULE_MESSAGE = `source must be one of: ${RULE_SOURCES.join(', ')}, and percent a finite number`;
const UNTIL_MESSAGE = 'until must be {"kind":"reset"}, {"kind":"manual"} or {"kind":"at","at":<a future ISO date>}';

const AGENT_MESSAGE = `agent, when given, must be one of: ${AGENT_IDS.join(', ')}`;

interface RuleBody { source?: unknown; percent?: unknown; until?: unknown; agent?: unknown }

// #929: the agent of the plan rule the strip names; absent is the default agent's. Undefined when the body names an unknown one
function bodyAgent(raw: unknown): { agent?: AgentId } | undefined {
  if (raw === undefined) return {};
  const agent = knownAgent(raw);
  return agent === undefined ? undefined : { agent };
}

/** The strip's desligar and religar (#297). The UI computes `at`; it and the server run on one machine, so this clock can judge "future".
 * A disable the reducer refuses (the rule stopped firing, or is already off) still answers like POST /signal: the next broadcast shows it. */
export function registerRuleRoutes(app: Express, { requireLive, dispatch }: Pick<TaskRouteDeps, 'requireLive' | 'dispatch'>): void {
  app.post('/rules/disable', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const { source, percent, until, agent: rawAgent } = (req.body ?? {}) as RuleBody;
    if (!isRuleSource(source) || !isPercent(percent)) return void res.status(HTTP_BAD_REQUEST).json({ error: RULE_MESSAGE });
    const agent = bodyAgent(rawAgent);
    if (agent === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: AGENT_MESSAGE });
    if (!isDisableUntil(until) || (until.kind === 'at' && Date.parse(until.at) <= Date.now())) {
      return void res.status(HTTP_BAD_REQUEST).json({ error: UNTIL_MESSAGE });
    }
    await dispatch({ type: 'disableRule', source, percent, until, ...agent });
    res.json({ ok: true });
  });
  app.post('/rules/enable', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const { source, percent, agent: rawAgent } = (req.body ?? {}) as RuleBody;
    if (!isRuleSource(source) || !isPercent(percent)) return void res.status(HTTP_BAD_REQUEST).json({ error: RULE_MESSAGE });
    const agent = bodyAgent(rawAgent);
    if (agent === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: AGENT_MESSAGE });
    await dispatch({ type: 'enableRule', source, percent, ...agent });
    res.json({ ok: true });
  });
}
