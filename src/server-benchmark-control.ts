// The benchmark's controls (#472, api.benchmark.control), mounted from registerBenchmarkRoutes behind the server's host, secret and
// x-hive-ui gates. The routes check the status and the body and refuse (#458: the reducer only applies); the runner holds the loop.
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { HH_MM } from './benchmark/deadline.js';
import type { BenchRunner } from './benchmark/runner.js';
import { missingRuns } from './benchmark/scheduler.js';
import type { Logger } from './log.js';
import type { BenchmarkEvent, Experiment, State } from './types.js';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const E = '/benchmark/experiments/:id';
const MAX_PAIRS = 100;
const MAX_REASON = 500;
const MORE = z.object({ pairs: z.number().int().positive().max(MAX_PAIRS) });
const SLEEP = z.object({ reason: z.string().trim().min(1).max(MAX_REASON), wakeAt: z.string().regex(HH_MM).optional() });
const WAKE = z.object({ deadline: z.union([z.literal('finish-round'), z.literal('none'), z.object({ until: z.string().regex(HH_MM) })]).optional() });

export interface BenchControlRouteDeps {
  requireLive(res: Response): { state: State } | undefined;
  runner: Pick<BenchRunner, 'run' | 'sleep' | 'wake' | 'isLive' | 'blindness'>;
  dispatch(event: BenchmarkEvent): Promise<unknown>;
  log: Pick<Logger, 'warn'>;
}

const fail = (res: Response, status: number, error: string, message: string): void => void res.status(status).json({ error, message });
const ok = (res: Response, status: number): void => void res.status(status).json({ ok: true });
const refuse = (res: Response, experiment: Experiment, action: string): void =>
  fail(res, HTTP_CONFLICT, 'status', `${action} is refused while the experiment is ${experiment.status}`);
const isRunning = (experiment: Experiment): boolean => experiment.status === 'running' || experiment.status === 'sleeping';

// current reads the experiment again from the live state, without touching the response
interface Found { experiment: Experiment; current(): Experiment | undefined }

// requireLive answers the response itself when the Hive is not live, so it is called once per request
function found(deps: BenchControlRouteDeps, req: Request, res: Response): Found | undefined {
  const live = deps.requireLive(res);
  if (live === undefined) return undefined;
  const id = String(req.params.id);
  const current = (): Experiment | undefined => live.state.benchmark.experiments.find((e) => e.id === id);
  const experiment = current();
  if (experiment === undefined) fail(res, HTTP_NOT_FOUND, 'unknown_experiment', `no experiment ${id}`);
  return experiment === undefined ? undefined : { experiment, current };
}

// server-benchmark.ts keeps its own copy: importing it from there would close an import cycle
function parsed<T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  fail(res, HTTP_BAD_REQUEST, 'bad_body', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  return undefined;
}

// more-rounds' edit: the loop reads pace.pairs when it starts, so the edit comes before `run`; `undo` puts the pace back when run does not start
interface PairsEdit { apply(): Promise<unknown>; undo(): Promise<unknown> }

// The blindness of every arm that will run first, so a refusal starts and edits nothing (spec); then the edit
async function start(deps: BenchControlRouteDeps, res: Response, experiment: Experiment, edit?: PairsEdit): Promise<void> {
  if (deps.runner.isLive(experiment.id)) return fail(res, HTTP_CONFLICT, 'live', 'the experiment is running in this Hive');
  const leak = await deps.runner.blindness(experiment);
  if (leak !== undefined) return fail(res, HTTP_UNPROCESSABLE, 'blindness', leak);
  await edit?.apply();
  const answer = await deps.runner.run(experiment.id).catch(async (err: unknown) => { await edit?.undo(); throw err; });
  if (answer === 'started') return ok(res, HTTP_ACCEPTED);
  await edit?.undo();
  fail(res, HTTP_CONFLICT, answer, answer === 'live' ? 'the experiment is running in this Hive' : 'another Hive is running this experiment');
}

function registerStartRoutes(app: Express, deps: BenchControlRouteDeps): void {
  app.post(`${E}/run`, async (req, res) => {
    const experiment = found(deps, req, res)?.experiment;
    if (experiment === undefined) return;
    if (isRunning(experiment)) return refuse(res, experiment, 'run');
    if (missingRuns(experiment).length === 0) return fail(res, HTTP_CONFLICT, 'nothing_missing', 'every run of every round has run');
    await start(deps, res, experiment);
  });
  app.post(`${E}/more-rounds`, async (req, res) => {
    const hit = found(deps, req, res);
    const body = hit === undefined ? undefined : parsed(MORE, req, res);
    if (hit === undefined || body === undefined) return;
    const { experiment } = hit;
    if (experiment.status === 'draft') return refuse(res, experiment, 'more-rounds');
    // the pace is read again where it is edited, undo included: the request's own read can be older than a concurrent edit, which an undo
    // must not clobber, so it takes back its pairs only
    const pairsBy = async (delta: number): Promise<unknown> => {
      const pace = hit.current()?.pace ?? experiment.pace;
      return deps.dispatch({ type: 'benchmarkEdited', id: experiment.id, patch: { pace: { ...pace, pairs: pace.pairs + delta } } });
    };
    const edit: PairsEdit = { apply: () => pairsBy(body.pairs), undo: () => pairsBy(-body.pairs) };
    if (isRunning(experiment)) { // the live loop reads pace.pairs before each round
      await edit.apply();
      return ok(res, HTTP_OK);
    }
    await start(deps, res, { ...experiment, pace: { ...experiment.pace, pairs: experiment.pace.pairs + body.pairs } }, edit);
  });
}

function registerPaceRoutes(app: Express, deps: BenchControlRouteDeps): void {
  app.post(`${E}/stop-after-round`, async (req, res) => {
    const experiment = found(deps, req, res)?.experiment;
    if (experiment === undefined) return;
    if (!isRunning(experiment)) return refuse(res, experiment, 'stop-after-round');
    await deps.dispatch({ type: 'benchmarkStopAfterRound', id: experiment.id, on: true });
    ok(res, HTTP_OK);
  });
  app.post(`${E}/sleep`, async (req, res) => {
    const experiment = found(deps, req, res)?.experiment;
    const body = experiment === undefined ? undefined : parsed(SLEEP, req, res);
    if (experiment === undefined || body === undefined) return;
    if (experiment.status !== 'running') return refuse(res, experiment, 'sleep');
    await deps.runner.sleep(experiment.id, body.reason, body.wakeAt);
    ok(res, HTTP_OK);
  });
  app.post(`${E}/wake`, (req, res) => {
    const experiment = found(deps, req, res)?.experiment;
    const body = experiment === undefined ? undefined : parsed(WAKE, req, res);
    if (experiment === undefined || body === undefined) return;
    if (experiment.status !== 'sleeping') return refuse(res, experiment, 'wake');
    // a wake after a restart reruns runs and resumes the loop: the answer does not wait for it
    void deps.runner.wake(experiment.id, body.deadline).catch(() => deps.log.warn(`benchmark ${experiment.id}: wake failed`));
    ok(res, HTTP_ACCEPTED);
  });
}

/** api.benchmark.control (#472). */
export function registerBenchmarkControlRoutes(app: Express, deps: BenchControlRouteDeps): void {
  registerStartRoutes(app, deps);
  registerPaceRoutes(app, deps);
}
