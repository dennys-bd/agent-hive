// The bench.report routes (#476): the aggregate, report.md and a run's inMedian. Mounted from server-benchmark.ts (1.2), the only benchmark
// route file server.ts mounts. Errors answer { error } with the status, as server-approval.ts's refuse does.
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { aggregate, type ReportFilter } from './benchmark/report.js';
import { renderReport } from './benchmark/report-md.js';
import type { Logger } from './log.js';
import { isJsonObject } from './state-guards.js';
import { BENCH_TOKEN, EXPERIMENT_ID, type Experiment, type HiveEvent, type State } from './types.js';

const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const NO_EXPERIMENT = 'no such experiment';
const NO_RUN = 'no such run in this experiment';
const FILTER_MESSAGE = 'filter must be in or out';
const BODY_MESSAGE = 'the body must be { inMedian: boolean }';
const WRITE_MESSAGE = 'report.md could not be written';

/** What the report routes need (#476): the state, the dispatch, the Hive's home the experiment folders live under, the writer and the log. */
export interface BenchmarkReportDeps {
  getState(): State | undefined; // undefined before the Hive is live: no experiment to answer
  dispatch(event: HiveEvent): Promise<unknown>;
  hiveDir: string;
  writeReport(dir: string, experiment: Experiment, now: number): Promise<void>;
  log: Logger;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error });
};

// The id is checked before the lookup, so a value that would name another folder never reaches join
function experimentOf(deps: Pick<BenchmarkReportDeps, 'getState'>, req: Request): Experiment | undefined {
  const id = req.params.id as string;
  return EXPERIMENT_ID.test(id) ? deps.getState()?.benchmark.experiments.find((e) => e.id === id) : undefined;
}

const holdsRun = (experiment: Experiment, token: string): boolean =>
  BENCH_TOKEN.test(token) && experiment.rounds.some((round) => round.runs.some((r) => r.token === token));

function filterOf(value: unknown): ReportFilter | undefined {
  if (value === undefined) return 'in';
  return value === 'in' || value === 'out' ? value : undefined;
}

// { inMedian } and nothing else: clearing an override has no screen, and any other key is a field of the run this route does not set
function inMedianOf(body: unknown): boolean | undefined {
  if (!isJsonObject(body) || Object.keys(body).length !== 1 || typeof body.inMedian !== 'boolean') return undefined;
  return body.inMedian;
}

/** GET /benchmark/experiments/:id/report (?filter=in|out), GET …/report.md (written, then answered) and PATCH …/runs/:token ({ inMedian }) (#476). */
export function registerBenchmarkReportRoutes(app: Express, deps: BenchmarkReportDeps): void {
  app.get('/benchmark/experiments/:id/report', (req: Request, res: Response) => {
    const experiment = experimentOf(deps, req);
    if (experiment === undefined) return refuse(res, HTTP_NOT_FOUND, NO_EXPERIMENT);
    const filter = filterOf(req.query.filter);
    if (filter === undefined) return refuse(res, HTTP_BAD_REQUEST, FILTER_MESSAGE);
    res.json(aggregate(experiment, filter, Date.now()));
  });
  app.get('/benchmark/experiments/:id/report.md', async (req: Request, res: Response) => {
    const experiment = experimentOf(deps, req);
    if (experiment === undefined) return refuse(res, HTTP_NOT_FOUND, NO_EXPERIMENT);
    const now = Date.now();
    try {
      await deps.writeReport(join(deps.hiveDir, 'benchmark', experiment.id), experiment, now);
    } catch (err) {
      // The id and the fs error only: the report maps tokens to arms, so its text never reaches the log
      deps.log.error(`report.md of experiment ${experiment.id} not written: ${errorMessage(err)}`);
      return refuse(res, HTTP_SERVER_ERROR, WRITE_MESSAGE);
    }
    res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.md"' })
      .send(renderReport(experiment, aggregate(experiment, 'in', now)));
  });
  app.patch('/benchmark/experiments/:id/runs/:token', async (req: Request, res: Response) => {
    const experiment = experimentOf(deps, req);
    if (experiment === undefined) return refuse(res, HTTP_NOT_FOUND, NO_EXPERIMENT);
    const token = req.params.token as string;
    if (!holdsRun(experiment, token)) return refuse(res, HTTP_NOT_FOUND, NO_RUN);
    const inMedian = inMedianOf(req.body);
    if (inMedian === undefined) return refuse(res, HTTP_BAD_REQUEST, BODY_MESSAGE);
    await deps.dispatch({ type: 'benchmarkRunChanged', id: experiment.id, token, patch: { inMedian } });
    res.status(HTTP_NO_CONTENT).end();
  });
}
