// The command-line checkers' runs (#782) and Settings › editor's detection of every checker. The page asks one run per checker once a save
// answered or a file opened, so a slow checker never holds the save, nor a fast one waits for it. A path resolves inside the activity's folder
// only: a report about a file the pane cannot place is no use.
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { Express, Request, Response } from 'express';
import { activityParam } from './activity-routes.js';
import { type CheckRuns, createCheckRuns, runCheck } from './check-run.js';
import { CHECKERS, checkerOn, cliCheckerDef, cliCheckersFor, isCliCheckerId } from './checkers.js';
import { findCandidate } from './formatter-detect.js';
import { otherExtensions } from './formatters.js';
import { languageOf } from './languages.js';
import { locate } from './server-editor.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import { withoutHiveEnv } from './spawn.js';
import type { CheckAnswer, CheckerState, Workspace } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const OUTSIDE_MESSAGE = 'path must be a file inside the activity';
const NO_WORKSPACE_MESSAGE = 'the activity has no workspace';

type Live = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;
type Store = TaskRouteDeps['consoleStore'];
type Handler = (req: Request, res: Response, current: Live) => Promise<void>;
// The activity's folder (a real path), the file in it, its path as the pane names it, the workspace whose config applies and the header's head
interface Placed { folder: string; file: string; path: string; workspace: Workspace; label: string }

const refuse = (res: Response, { status, message }: Refusal): void => { res.status(status).json({ error: message }); };

// The editor's own location of the file, then the checker's two extra rules: a workspace, and a file inside the folder
async function place(current: Live, id: string, path: unknown): Promise<Placed | Refusal> {
  const located = await locate(current, id, path);
  if ('status' in located) return located;
  if (located.workspace === undefined) return { status: HTTP_CONFLICT, message: NO_WORKSPACE_MESSAGE };
  const folder = await realpath(located.folder); // a tool reports real paths
  if (!located.file.startsWith(`${folder}${sep}`)) return { status: HTTP_BAD_REQUEST, message: OUTSIDE_MESSAGE };
  return { folder, file: located.file, path: located.file.slice(folder.length + 1), workspace: located.workspace, label: located.label };
}

// One run (#782): a newer one of the same (activity, checker, target) supersedes it; off for the workspace answers absent without a run
async function check(req: Request, res: Response, current: Live, deps: { runs: CheckRuns; consoleStore: Store }): Promise<void> {
  const id = String(req.params.checker);
  if (!isCliCheckerId(id)) return refuse(res, { status: HTTP_BAD_REQUEST, message: `${id} is not a command-line checker` });
  const located = await place(current, activityParam(req), ((req.body ?? {}) as { path?: unknown }).path);
  if ('status' in located) return refuse(res, located);
  const def = cliCheckerDef(id);
  const { editor } = current.runtime.config;
  const language = languageOf(located.file, otherExtensions(editor));
  if (language === undefined || !cliCheckersFor(language, located.file).includes(def)) return refuse(res, { status: HTTP_BAD_REQUEST, message: `${id} does not check ${located.path}` });
  if (!checkerOn(editor, language, id, located.workspace.name)) return void res.json({ state: 'absent' } satisfies CheckAnswer);
  const target = def.scope === 'file' ? located.path : 'project';
  const key = `${activityParam(req)}\0${id}\0${target}`;
  const signal = deps.runs.start(key);
  try {
    const release = await deps.runs.slot(signal);
    if (release === undefined) return void res.json({ state: 'superseded' } satisfies CheckAnswer);
    try {
      const args = editor.languages[language]?.checkers?.[id]?.args ?? [];
      const env = { ...withoutHiveEnv(process.env), ...located.workspace.env };
      res.json(await runCheck(def, { folder: located.folder, file: located.file, args, env, workspace: located.workspace.name, label: `${located.label} · ${target}`, consoleStore: deps.consoleStore, signal }));
    } finally {
      release();
    }
  } finally {
    deps.runs.end(key, signal);
  }
}

// Settings › editor's detection (#782): every checker on each workspace's checkout, as the formatters' are; a language-server one by its project
// copy only (the Hive's install is the installs listing's), a command-line one by its candidates, the workspace's PATH before the daemon's
async function checkerStates(_req: Request, res: Response, current: Live): Promise<void> {
  const { workspaces } = current.runtime.config.comb;
  const states = await Promise.all(CHECKERS.map(async (def): Promise<CheckerState> => {
    const found = await Promise.all(workspaces.map(async (w) => {
      const binary = def.kind === 'lsp' ? await findCandidate(def.project, w.path, '') : await findCandidate(def.candidates, w.path, w.env.PATH ?? process.env.PATH ?? '');
      return binary === undefined ? [] : [w.name];
    }));
    return { id: def.id, found: found.flat() };
  }));
  res.json(states);
}

/** POST /activities/:id/check/:checker and GET /settings/checkers (#782), behind the same requireLive as the editor's routes. Whatever the disk
 * throws answers 500 with its message. */
export function registerCheckRoutes(app: Express, { requireLive, consoleStore }: Pick<TaskRouteDeps, 'requireLive' | 'consoleStore'>): void {
  const runs = createCheckRuns();
  const route = (handle: Handler) => async (req: Request, res: Response): Promise<void> => {
    const current = requireLive(res);
    if (!current) return;
    try {
      await handle(req, res, current);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post('/activities/:id/check/:checker', route((req, res, current) => check(req, res, current, { runs, consoleStore })));
  app.get('/settings/checkers', route(checkerStates));
}
