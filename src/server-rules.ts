import type { Express, Request, Response } from 'express';
import type { TaskRouteDeps } from './server-tasks.js';
import { RULE_SOURCES } from './types.js';
import { isDisableUntil, isPercent, isRuleSource } from './usage-rules.js';

const HTTP_BAD_REQUEST = 400;
const RULE_MESSAGE = `source must be one of: ${RULE_SOURCES.join(', ')}, and percent a finite number`;
const UNTIL_MESSAGE = 'until must be {"kind":"reset"}, {"kind":"manual"} or {"kind":"at","at":<a future ISO date>}';

interface RuleBody { source?: unknown; percent?: unknown; until?: unknown }

/** The strip's desligar and religar (#297). The UI computes `at`; it and the server run on one machine, so this clock can judge "future".
 * A disable the reducer refuses (the rule stopped firing, or is already off) still answers like POST /signal: the next broadcast shows it. */
export function registerRuleRoutes(app: Express, { requireLive, dispatch }: Pick<TaskRouteDeps, 'requireLive' | 'dispatch'>): void {
  app.post('/rules/disable', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const { source, percent, until } = (req.body ?? {}) as RuleBody;
    if (!isRuleSource(source) || !isPercent(percent)) return void res.status(HTTP_BAD_REQUEST).json({ error: RULE_MESSAGE });
    if (!isDisableUntil(until) || (until.kind === 'at' && Date.parse(until.at) <= Date.now())) {
      return void res.status(HTTP_BAD_REQUEST).json({ error: UNTIL_MESSAGE });
    }
    await dispatch({ type: 'disableRule', source, percent, until });
    res.json({ ok: true });
  });
  app.post('/rules/enable', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const { source, percent } = (req.body ?? {}) as RuleBody;
    if (!isRuleSource(source) || !isPercent(percent)) return void res.status(HTTP_BAD_REQUEST).json({ error: RULE_MESSAGE });
    await dispatch({ type: 'enableRule', source, percent });
    res.json({ ok: true });
  });
}
