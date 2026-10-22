import type { Express, Request, Response } from 'express';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import { treeCheckout, treeRoot } from './server-tree.js';
import { wordsOf } from './worktree.js';

// The files sidebar's lease on its tree (#502): the page posts one per shown sidebar and renews it; the daemon watches that root while any
// lease holds it. No value of the request picks the folder: treeRoot does, as for every tree route.

export const LEASE_MAX_LENGTH = 64;
export const LEASE_BODY_MESSAGE = 'lease must be a non-empty string of at most 64 characters';
const HTTP_BAD_REQUEST = 400;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVER_ERROR = 500;

const refuse = (res: Response, refusal: Refusal): void => { res.status(refusal.status).json({ error: refusal.message }); };
const isLease = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= LEASE_MAX_LENGTH;

/** POST /activities/:id/tree/watch (`{ lease }`) and DELETE /activities/:id/tree/watch/:lease (#502); 204 both, an unknown lease's DELETE too. */
export function registerTreeWatchRoutes(app: Express, { requireLive, treeWatch }: Pick<TaskRouteDeps, 'requireLive' | 'treeWatch'>): void {
  app.post('/activities/:id/tree/watch', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    const root = treeRoot(current.state, current.runtime.config, id);
    if (typeof root !== 'string') return refuse(res, root);
    const { lease } = (req.body ?? {}) as { lease?: unknown };
    if (!isLease(lease)) return refuse(res, { status: HTTP_BAD_REQUEST, message: LEASE_BODY_MESSAGE });
    try {
      // A checkout holds the other activities' worktrees under .hive/worktrees: treeCheckout tells it apart, as GET /tree does (#131)
      await treeWatch.lease(id, root, lease, treeCheckout(current.state, current.runtime.config, id, root) === undefined);
      res.status(HTTP_NO_CONTENT).end();
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
  app.delete('/activities/:id/tree/watch/:lease', (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const root = treeRoot(current.state, current.runtime.config, req.params.id as string);
    if (typeof root !== 'string') return refuse(res, root);
    treeWatch.release(req.params.lease as string);
    res.status(HTTP_NO_CONTENT).end();
  });
}
