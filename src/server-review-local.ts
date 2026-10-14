import type { Express, Request, Response } from 'express';
import { type LocalReviewDeps, localSubject, type ReviewSubject } from './review-subject.js';
import { refuse, registerStoreRoutes } from './server-review.js';
import { registerThreadRoutes } from './server-review-threads.js';
import { UNKNOWN_WORKSPACE_MESSAGE } from './server-memory.js';
import type { TaskRouteDeps } from './server-tasks.js';

const HTTP_NOT_FOUND = 404;
const LOCAL_PREFIX = '/workspaces/:name'; // the memory routes' shape (#797)

export type LocalReviewRouteDeps = Pick<TaskRouteDeps, 'requireLive' | 'log'> & LocalReviewDeps;

// The workspace a local review route names, as its review's subject: only a workspace of the live State, so the unencoded name is always a
// WORKSPACE_NAME. Undefined once its 409 or 404 is out
function localSubjectIn(deps: LocalReviewRouteDeps, req: Request, res: Response): ReviewSubject | undefined {
  const current = deps.requireLive(res);
  if (!current) return undefined;
  const workspace = req.params.name as string; // a :name segment is one string
  if (!current.state.workspaces.includes(workspace)) {
    refuse(res, { status: HTTP_NOT_FOUND, message: UNKNOWN_WORKSPACE_MESSAGE });
    return undefined;
  }
  return localSubject(deps, current.state, workspace);
}

/** A workspace's local review (#344): the task review's routes under /workspaces/:name, except the reviewed marks, which belong to the diff
 * pane. */
export function registerLocalReviewRoutes(app: Express, deps: LocalReviewRouteDeps): void {
  const subjectOf = (req: Request, res: Response): ReviewSubject | undefined => localSubjectIn(deps, req, res);
  registerStoreRoutes(app, LOCAL_PREFIX, subjectOf);
  registerThreadRoutes(app, LOCAL_PREFIX, subjectOf, deps.log);
}
