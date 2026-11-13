import type { Express, Request, Response } from 'express';
import type { CommandSemaphores } from './command-semaphores.js';
import { refuse } from './server-tasks.js';
import type { State } from './types.js';

// The Command Semaphores' routes (#798): the shim's acquire and release under /hooks/, behind the secret and x-hive-pty as every hook (server.ts'
// gate), and the UI's run now under /api/, behind the UI header too. The answers to the shim are plain lines, which a POSIX read splits.

const HTTP_BAD_REQUEST = 400;
const HTTP_NO_CONTENT = 204;
const HTTP_CONFLICT = 409;
export const NOT_IN_LINE_CODE = 'not_in_line'; // node 4 words it
const NOT_IN_LINE_MESSAGE = 'no place in line on that semaphore';
const BAD_ACQUIRE_MESSAGE = 'acquire takes { argv: string[], pid: a positive integer, now?: true }';
const BAD_RELEASE_MESSAGE = 'release takes { semaphore: string }';
const BAD_RUN_NOW_MESSAGE = 'run now takes { ptyId: string }';

export interface SemaphoreRouteDeps {
  state(): State | undefined; // live.state; undefined in setup mode
  semaphores(): CommandSemaphores | undefined; // created with the first config
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isArgv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((a: unknown) => typeof a === 'string');
// Positive only: process.kill(0 or -n, 0) would probe a whole process group
const isPid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const plain = (res: Response, answer: string): void => { res.type('text/plain').send(`${answer}\n`); };

/** The pty behind x-hive-pty (#798, decision 4): an agent's when it is a Worker's runId (a stage run, a session, a session captured in a
 * terminal); a terminal or a commands stage's command waits in place. undefined: unknown, which runs. */
export function ptyOf(state: State, ptyId: string): { isAgent: boolean; workspace: string } | undefined {
  const worker = state.workers.find((w) => w.runId === ptyId);
  const activityId = worker?.activityId
    ?? state.terminals.find((t) => t.terminalId === ptyId)?.activityId
    ?? state.activities.find((a) => a.commands?.ptyId === ptyId)?.id; // a commands stage's worker has no runId (stage-commands.ts)
  const workspace = state.activities.find((a) => a.id === activityId)?.workspace;
  return workspace === undefined ? undefined : { isAgent: worker !== undefined, workspace };
}

function acquireBody(raw: unknown): { argv: string[]; pid: number; now?: true } | undefined {
  if (!isRecord(raw)) return undefined;
  const { argv, pid, now } = raw;
  if (!isArgv(argv) || !isPid(pid) || (now !== undefined && now !== true)) return undefined;
  return { argv, pid, ...(now === true ? { now } : {}) };
}

// Decision 21: a bad body is a 400 and the shim runs the binary; no Hive, no pty or an unknown one answers run
function registerAcquire(app: Express, deps: SemaphoreRouteDeps): void {
  app.post('/hooks/semaphores/acquire', (req: Request, res: Response) => {
    const body = acquireBody(req.body);
    if (body === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: BAD_ACQUIRE_MESSAGE });
    const ptyId = req.header('x-hive-pty');
    const state = deps.state();
    const semaphores = deps.semaphores();
    const pty = ptyId === undefined || state === undefined ? undefined : ptyOf(state, ptyId);
    if (ptyId === undefined || pty === undefined || semaphores === undefined) return plain(res, 'run');
    plain(res, semaphores.acquire({ ptyId, ...pty, ...body }));
  });
}

function registerRelease(app: Express, deps: SemaphoreRouteDeps): void {
  app.post('/hooks/semaphores/release', (req: Request, res: Response) => {
    const semaphore = isRecord(req.body) && typeof req.body.semaphore === 'string' ? req.body.semaphore : undefined;
    if (semaphore === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: BAD_RELEASE_MESSAGE });
    const ptyId = req.header('x-hive-pty');
    if (ptyId !== undefined) deps.semaphores()?.release(ptyId, semaphore);
    res.status(HTTP_NO_CONTENT).end();
  });
}

// Decision 17: the card's action (node 4); a pty with no place there is a 409
function registerRunNow(app: Express, deps: SemaphoreRouteDeps): void {
  app.post('/api/semaphores/:name/run-now', (req: Request, res: Response) => {
    const ptyId = isRecord(req.body) && typeof req.body.ptyId === 'string' && req.body.ptyId !== '' ? req.body.ptyId : undefined;
    if (ptyId === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: BAD_RUN_NOW_MESSAGE });
    if (deps.semaphores()?.runNow(String(req.params.name), ptyId) !== true) return refuse(res, { status: HTTP_CONFLICT, message: NOT_IN_LINE_MESSAGE, code: NOT_IN_LINE_CODE });
    res.json({ ok: true });
  });
}

/** The Command Semaphores' three routes (#798). */
export function registerSemaphoreRoutes(app: Express, deps: SemaphoreRouteDeps): void {
  registerAcquire(app, deps);
  registerRelease(app, deps);
  registerRunNow(app, deps);
}
