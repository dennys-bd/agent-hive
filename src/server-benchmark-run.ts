// The run-hive route (#475, api.benchmark.run-hive): what "abrir" on a benchmark run calls before the window moves to the run's own Hive.
// Mounted from server-benchmark.ts (1.2). A running run's daemon is 3.2's, so its port is only read. An ended run gets a frozen daemon,
// at most one at a time, which this module holds and stops. Errors answer { error } with the status, as server-benchmark-report.ts does.
import type { Express, Request, Response } from 'express';
import { bootRun, type RunningDaemon, stopRunDaemon } from './benchmark/daemon.js';
import { MARKER_FILE } from './benchmark/run-home.js';
import { readMarker, writeMarker } from './benchmark/run-mode.js';
import { type DaemonAddress, ourDaemon } from './daemon.js';
import type { Logger } from './log.js';
import { secretCookie } from './secret.js';
import { BENCH_TOKEN, type BenchRun, type BenchRunStatus, EXPERIMENT_ID, type Experiment, type State } from './types.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const NO_EXPERIMENT = 'no such experiment';
const NO_RUN = 'no such run in this experiment';
const ENDED: readonly BenchRunStatus[] = ['done', 'timeout', 'error', 'interrupted'];

export interface BenchmarkRunDeps {
  getState(): State | undefined;
  address?(home: string): Promise<DaemonAddress | undefined>; // default ourDaemon: the home's hive.port and hive.secret, probed
  boot?(home: string): Promise<RunningDaemon>; // default bootRun (3.1)
  stop?(daemon: RunningDaemon): Promise<void>; // default stopRunDaemon (3.1)
  log: Pick<Logger, 'error'>;
}
/** The shutdown hook: the main Hive's close() stops the frozen daemon this module holds. */
export interface BenchmarkRunRoutes { close(): Promise<void> }

const refuse = (res: Response, status: number, error: string): void => void res.status(status).json({ error });

// The id and the token are checked before the lookup, as every benchmark route file does
function lookup(state: State | undefined, req: Request): { experiment?: Experiment; run?: BenchRun } {
  const id = String(req.params.id);
  const token = String(req.params.token);
  const experiment = EXPERIMENT_ID.test(id) ? state?.benchmark.experiments.find((e) => e.id === id) : undefined;
  const run = experiment !== undefined && BENCH_TOKEN.test(token) ? experiment.rounds.flatMap((r) => r.runs).find((r) => r.token === token) : undefined;
  return { experiment, run };
}

// The window's cookie for the run's port, set on the main port's answer. A cookie ignores the port, so this host's cookie reaches the run's,
// and the name carries the port, so the main port's own cookie stays for the way back (#467). HttpOnly: the page never reads it
function answer(res: Response, { port, secret }: DaemonAddress): void {
  res.cookie(secretCookie(port), secret, { httpOnly: true, sameSite: 'strict', path: '/' });
  res.json({ port });
}

/** POST /benchmark/experiments/:id/runs/:token/open (#475). Serialized, so two clicks never boot twice. */
export function registerBenchmarkRunRoutes(app: Express, deps: BenchmarkRunDeps): BenchmarkRunRoutes {
  const address = deps.address ?? ourDaemon;
  const boot = deps.boot ?? ((home: string) => bootRun(home));
  const stop = deps.stop ?? ((daemon: RunningDaemon) => stopRunDaemon(daemon));
  let held: RunningDaemon | undefined; // the one frozen daemon this Hive booted: never more than one idle
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
  const release = async (): Promise<void> => {
    const daemon = held;
    held = undefined;
    if (daemon !== undefined) await stop(daemon);
  };
  // The run branch must not change after its evaluation: the marker says frozen before the daemon reads it
  async function bootFrozen(home: string): Promise<RunningDaemon> {
    await release();
    const marker = await readMarker(home);
    if (marker === undefined) throw new Error(`${MARKER_FILE} is missing`);
    await writeMarker(home, { ...marker, frozen: true });
    held = await boot(home);
    return held;
  }
  async function open(req: Request, res: Response): Promise<void> {
    const { experiment, run } = lookup(deps.getState(), req);
    if (experiment === undefined) return refuse(res, HTTP_NOT_FOUND, NO_EXPERIMENT);
    if (run === undefined) return refuse(res, HTTP_NOT_FOUND, NO_RUN);
    if (run.status === 'queued') return refuse(res, HTTP_CONFLICT, 'not-started');
    const up = await address(run.home);
    if (up !== undefined) return answer(res, up);
    if (!ENDED.includes(run.status)) return refuse(res, HTTP_CONFLICT, 'unreachable'); // 3.2's scheduler owns a live run's daemon
    try {
      answer(res, (await bootFrozen(run.home)).address);
    } catch (err) {
      deps.log.error(`benchmark ${experiment.id}: a run's frozen daemon did not boot: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, HTTP_BAD_GATEWAY, 'boot');
    }
  }
  app.post('/benchmark/experiments/:id/runs/:token/open', (req: Request, res: Response) => serial(() => open(req, res)));
  return { close: () => serial(release) };
}
