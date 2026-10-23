// The benchmark's evaluate routes (#474), mounted from registerBenchmarkRoutes behind the server's host, secret and x-hive-ui gates.
import type { Express, Request, Response } from 'express';
import type { BenchEvaluator } from './benchmark/evaluate-service.js';
import { evaluableTokens } from './benchmark/report.js';
import type { Logger } from './log.js';
import type { BenchRunStatus, Experiment, State } from './types.js';

const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];
const E = '/benchmark/experiments/:id';

export interface BenchEvaluateRouteDeps {
  requireLive(res: Response): { state: State } | undefined;
  evaluator: Pick<BenchEvaluator, 'evaluate' | 'isEvaluating'>;
  log: Pick<Logger, 'warn'>;
}

// The evaluation can take hours (#474): the route answers at once and the service dispatches the result
function start(deps: BenchEvaluateRouteDeps, res: Response, id: string, tokens: string[], markRounds = false): void {
  void deps.evaluator.evaluate(id, tokens, markRounds).catch(() => deps.log.warn(`benchmark ${id}: evaluation failed`));
  res.status(HTTP_ACCEPTED).json({ tokens });
}

// requireLive answers the response itself when the Hive is not live, so it is called once per request
const experimentOf = (deps: BenchEvaluateRouteDeps, req: Request, res: Response): Experiment | undefined => {
  const live = deps.requireLive(res);
  if (live === undefined) return undefined;
  const experiment = live.state.benchmark.experiments.find((e) => e.id === String(req.params.id));
  if (experiment === undefined) res.status(HTTP_NOT_FOUND).json({ error: 'unknown experiment' });
  return experiment;
};

export function registerBenchmarkEvaluateRoutes(app: Express, deps: BenchEvaluateRouteDeps): void {
  app.post(`${E}/evaluate`, (req, res) => {
    const experiment = experimentOf(deps, req, res);
    if (experiment === undefined) return;
    const tokens = evaluableTokens(experiment);
    if (tokens.some((token) => deps.evaluator.isEvaluating(token))) return void res.status(HTTP_CONFLICT).json({ error: 'a run of this experiment is being evaluated' });
    start(deps, res, experiment.id, tokens, true); // only this route marks rounds evaluated
  });
  app.post(`${E}/runs/:token/evaluate`, (req, res) => {
    const experiment = experimentOf(deps, req, res);
    if (experiment === undefined) return;
    const token = String(req.params.token);
    const run = experiment.rounds.flatMap((r) => r.runs).find((r) => r.token === token);
    if (run === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: 'unknown run' });
    if (!ENDED.includes(run.status)) return void res.status(HTTP_CONFLICT).json({ error: 'the run has not ended' });
    if (deps.evaluator.isEvaluating(token)) return void res.status(HTTP_CONFLICT).json({ error: 'the run is being evaluated' });
    start(deps, res, experiment.id, [token]);
  });
}
