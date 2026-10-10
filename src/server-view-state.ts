import type { Express, Request, Response } from 'express';
import type { Logger } from './log.js';
import { isViewKey, VIEW_KEYS, VIEW_VALUE_MAX_BYTES } from './view-state.js';
import type { ViewStore } from './view-store.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
export const VIEW_KEY_MESSAGE = `key must be one of: ${VIEW_KEYS.join(', ')}`;
export const VIEW_VALUE_MESSAGE = 'body must be { "value": <any JSON value> }';
export const VIEW_SIZE_MESSAGE = `value must serialise to at most ${VIEW_VALUE_MAX_BYTES} bytes`;
export const VIEW_WRITE_MESSAGE = 'view state not written';

export interface ViewStateRouteDeps {
  store: ViewStore;
  log: Pick<Logger, 'error'>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Only the presence and the size of the value are checked: each UI module parses its own and falls back to its defaults on anything it
// does not recognise, and only the dashboard writes here (#484). JSON null is a value.
function valueProblem(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'value')) return VIEW_VALUE_MESSAGE;
  const size = Buffer.byteLength(JSON.stringify((body as { value: unknown }).value));
  return size > VIEW_VALUE_MAX_BYTES ? VIEW_SIZE_MESSAGE : undefined;
}

/** GET /view-state and POST /view-state/:key (#484): the whole map at load, one key per write, so the dock and the filters never overwrite
 *  each other. Neither needs a live config: the dashboard reads its layout before setup too. POST, so the x-hive-ui gate covers it. A
 *  failed write is logged with its key and the error, never the value. */
export function registerViewStateRoutes(app: Express, { store, log }: ViewStateRouteDeps): void {
  app.get('/view-state', (_req: Request, res: Response) => void res.json(store.get()));
  app.post('/view-state/:key', async (req: Request, res: Response) => {
    const { key } = req.params;
    if (!isViewKey(key)) return void res.status(HTTP_BAD_REQUEST).json({ error: VIEW_KEY_MESSAGE });
    const problem = valueProblem(req.body);
    if (problem !== undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: problem });
    try {
      await store.set(key, (req.body as { value: unknown }).value);
      res.json({ ok: true });
    } catch (err) {
      log.error(`view state ${key} not written: ${errorMessage(err)}`);
      res.status(HTTP_SERVER_ERROR).json({ error: VIEW_WRITE_MESSAGE });
    }
  });
}
