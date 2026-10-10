// GET /activities/:id/file-base (#668): the base a file's changes compare against, for the editor pane's gutter marks and the changes pane.
// HEAD, or the task's base: the merge-base the diff pane's worktree scope diffs from (diffBase). The file is located as the editor's routes
// locate it; the blob is read with git in the activity's folder, every call an argv. Only the blob's id goes back when the page holds it.
import { relative } from 'node:path';
import type { Express, Request, Response } from 'express';
import { activityParam } from './activity-routes.js';
import { holdableText } from './decode-text.js';
import { taskWorkspace } from './config.js';
import { type DiffBase, diffBase } from './diff.js';
import { workspaceBase } from './fork.js';
import { isInside } from './ide.js';
import { type Located, locate } from './server-editor.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import { type ChangesBase, type Config, EDITOR_FILE_MAX, type Exec, type FileBase } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const HEAD = 'HEAD';
const AGAINST_MESSAGE = 'against must be head or task';
const LOCAL_MESSAGE = 'a local activity has no task base';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, { status, message }: Refusal): void => {
  res.status(status).json({ error: message });
};
const isChangesBase = (value: unknown): value is ChangesBase => value === 'head' || value === 'task';

// git's output, or undefined when it fails: no repository, no such blob. Each caller reads a failure as "no base" in its own way
async function gitOut(folder: string, args: string[], exec: Exec): Promise<string | undefined> {
  try {
    return (await exec('git', ['-C', folder, ...args])).stdout;
  } catch {
    return undefined;
  }
}

// The commit the file compares against and its label: HEAD, or the task's merge-base as the diff pane names it
function commitOf(located: Located, against: ChangesBase, config: Pick<Config, 'baseBranch' | 'comb'>, exec: Exec): Promise<DiffBase> {
  if (against === 'head' || located.task === undefined) return Promise.resolve({ commit: HEAD, label: HEAD });
  return diffBase(located.task, located.activity, workspaceBase(config, taskWorkspace(config, located.task)), located.folder, 'worktree', exec); // #854
}

// The file's path in its repository; undefined outside a repository, or for a file outside it
async function repoPath(located: Located, exec: Exec): Promise<string | undefined> {
  const top = (await gitOut(located.folder, ['rev-parse', '--show-toplevel'], exec))?.trim();
  return top === undefined || top === '' || !isInside(top, located.file) ? undefined : relative(top, located.file);
}

// The blob's text when the editor could hold it (#717's caps: EDITOR_FILE_MAX, UTF-8, no NUL), else undefined
async function blobText(folder: string, oid: string, exec: Exec): Promise<string | undefined> {
  const size = Number((await gitOut(folder, ['cat-file', '-s', oid], exec))?.trim());
  if (!Number.isInteger(size) || size > EDITOR_FILE_MAX) return undefined;
  const text = await gitOut(folder, ['cat-file', 'blob', oid], exec);
  return text === undefined ? undefined : holdableText(text);
}

// The answer (#668): no text without a base; '' for a file the base does not have (all of it added); the id alone when the page holds it
async function fileBaseOf(located: Located, against: ChangesBase, held: string | undefined, config: Pick<Config, 'baseBranch' | 'comb'>, exec: Exec): Promise<FileBase> {
  const { commit, label } = await commitOf(located, against, config, exec);
  const none: FileBase = { against, label };
  const path = await repoPath(located, exec);
  if (path === undefined) return none;
  const oid = (await gitOut(located.folder, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`], exec))?.trim();
  if (oid === undefined || oid === '') return { ...none, text: '' };
  if (oid === held) return { ...none, oid };
  const text = await blobText(located.folder, oid, exec);
  return text === undefined ? none : { ...none, oid, text };
}

/** GET /activities/:id/file-base?path=&against=head|task&oid= (#668), behind requireLive as the editor's routes. locate's refusals (404, a deleted
 * activity's 409, no path's 400), then 400 for an `against` other than head or task, or task on a local activity. Whatever git or the disk
 * throws answers 500 with its message. */
export function registerFileBaseRoutes(app: Express, { requireLive, exec }: Pick<TaskRouteDeps, 'requireLive' | 'exec'>): void {
  app.get('/activities/:id/file-base', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    try {
      const located = await locate(current, activityParam(req), req.query.path);
      if ('status' in located) return refuse(res, located);
      const { against, oid } = req.query;
      if (!isChangesBase(against)) return refuse(res, { status: HTTP_BAD_REQUEST, message: AGAINST_MESSAGE });
      if (against === 'task' && located.task === undefined) return refuse(res, { status: HTTP_BAD_REQUEST, message: LOCAL_MESSAGE });
      const held = typeof oid === 'string' && oid !== '' ? oid : undefined;
      res.json(await fileBaseOf(located, against, held, current.runtime.config, exec));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    }
  });
}
