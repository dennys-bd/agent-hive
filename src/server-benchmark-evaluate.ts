// The benchmark's evaluate routes (#474) and the screenshot route of the run result screen (#466), mounted from registerBenchmarkRoutes behind the server's host, secret and x-hive-ui gates.
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { evalPaths } from './benchmark/evaluate.js';
import type { BenchEvaluator } from './benchmark/evaluate-service.js';
import { evaluableTokens } from './benchmark/report.js';
import type { Logger } from './log.js';
import type { BenchRun, BenchRunStatus, Experiment, State } from './types.js';

const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error'];
const E = '/benchmark/experiments/:id';
const SCREEN_NAME = /^[\w.-]+\.png$/;
// decision 10 of #498 (server-editor.ts): a screenshot only ever reaches an <img>; sandbox holds if its URL is opened as a page
const SCREEN_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Content-Type': 'image/png' };
const NO_SCREEN = 'unknown screenshot';

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

const runIn = (experiment: Experiment, token: string): BenchRun | undefined => experiment.rounds.flatMap((r) => r.runs).find((r) => r.token === token);

// The name must be one the evaluation recorded for this run: the allow-list is what closes path traversal, the pattern only fails fast
function sendScreen(deps: BenchEvaluateRouteDeps, req: Request, res: Response): void {
  const experiment = experimentOf(deps, req, res);
  if (experiment === undefined) return;
  const run = runIn(experiment, String(req.params.token));
  const name = String(req.params.name);
  const isListed = SCREEN_NAME.test(name) && (run?.evaluation?.scenarios.some((s) => s.screenshots.includes(name)) ?? false);
  if (run === undefined || !isListed) return void res.status(HTTP_NOT_FOUND).json({ error: NO_SCREEN });
  // dotfiles: the Hive's home may sit under a dot folder, as worktrees do for server-editor.ts
  res.sendFile(join(evalPaths(run.home).screens, name), { dotfiles: 'allow', headers: SCREEN_HEADERS }, (err) => {
    if (err && !res.headersSent) res.status(HTTP_NOT_FOUND).json({ error: NO_SCREEN });
  });
}

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
    const run = runIn(experiment, token);
    if (run === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: 'unknown run' });
    if (!ENDED.includes(run.status)) return void res.status(HTTP_CONFLICT).json({ error: 'the run has not ended' });
    if (deps.evaluator.isEvaluating(token)) return void res.status(HTTP_CONFLICT).json({ error: 'the run is being evaluated' });
    start(deps, res, experiment.id, [token]);
  });
  app.get(`${E}/runs/:token/screens/:name`, (req, res) => sendScreen(deps, req, res));
}
