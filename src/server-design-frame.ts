// The design pane's frame (#108): an authenticated call mints a URL for one Hive design of an activity, and a read-only route serves that
// design's folder under the URL's token, outside the secret gate. A sandboxed frame has an opaque origin and no usable credential, so the
// token is the capability and the route never reads the port's cookie. Every answer carries its own sandboxing policy.
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import type { Express, Request, Response } from 'express';
import { activityParam } from './activity-routes.js';
import { bridgeScript } from './design-bridge.js';
import { isInside } from './ide.js';
import type { Logger } from './log.js';
import { DESIGN_FRAME_PREFIX, newSecret } from './secret.js';
import { locate } from './server-editor.js';
import { DISK, MISSING_FILE_MESSAGE } from './server-files.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';

const HEAD_TAG = /<head\b[^>]*>/i; // \b: <header> is not <head>
const FIRST_ELEMENT = /<[a-z]/i; // a doctype or a comment is not an element: the bridge never lands before it
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const DESIGN_SUFFIX = '.hv.html';
const NOT_DESIGN_MESSAGE = 'not a Hive design';
// A refusal is for no folder the route serves, so it gets the tightest policy rather than one naming the asked token
const REFUSED_POLICY = "sandbox; default-src 'none'; frame-ancestors 'self'";

type Live = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;
interface FrameDeps { tokens: DesignFrameTokens; log: Pick<Logger, 'debug'> }
interface MintDeps { requireLive: TaskRouteDeps['requireLive']; tokens: DesignFrameTokens }

/** This boot's design frame tokens (#108). Minting a folder again answers its token, so the map stays bounded by the folders the user
 *  opened. Memory only: a restart voids every URL. */
export interface DesignFrameTokens { mint(folder: string): string; folderOf(token: string): string | undefined }

export function createDesignFrameTokens(): DesignFrameTokens {
  const folderByToken = new Map<string, string>();
  const tokenByFolder = new Map<string, string>();
  return {
    mint(folder) {
      const held = tokenByFolder.get(folder);
      if (held !== undefined) return held;
      const token = newSecret(); // 32 random bytes in hex, as the boot's own secret
      folderByToken.set(token, folder);
      tokenByFolder.set(folder, token);
      return token;
    },
    folderOf: (token) => folderByToken.get(token),
  };
}

/** The route's policy (#108). `sandbox` in the header holds even when the URL is opened outside the iframe. 'self' is unreliable in an
 *  opaque origin, so the route is named. Designs are inline-heavy, hence 'unsafe-inline'. frame-ancestors stops another local port from
 *  framing it. */
export function framePolicy(host: string, token: string): string {
  const route = `http://${host}${DESIGN_FRAME_PREFIX}${token}/`;
  return [
    'sandbox allow-scripts', "default-src 'none'", `script-src ${route} 'unsafe-inline' data: blob:`, `style-src ${route} 'unsafe-inline' data: blob:`,
    `img-src ${route} data: blob:`, `font-src ${route} data: blob:`, `media-src ${route} data: blob:`, "connect-src 'none'", "frame-src 'none'",
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
  ].join('; ');
}

/** The page with the bridge first in its <head>, else before its first element (#108): it runs before the design's own scripts. */
export function withBridge(html: string): string {
  const head = HEAD_TAG.exec(html);
  const at = head ? head.index + head[0].length : Math.max(html.search(FIRST_ELEMENT), 0);
  return `${html.slice(0, at)}${bridgeScript()}${html.slice(at)}`;
}

// A dot segment (.env, .git, .hive) is never a design's asset, and serving one would hand a token holder the checkout's secrets
const hasDotSegment = (folder: string, path: string): boolean => relative(folder, path).split(sep).some((part) => part.startsWith('.'));

// The asked file, if it is a regular file strictly inside the token's folder and under no dot segment: checked on the joined path (nothing
// outside is even probed), then on its realpath (a symlink out, or onto a dotfile, is caught)
async function servedFile(folder: string, segments: string[]): Promise<string | undefined> {
  const asked = resolve(folder, ...segments);
  if (!isInside(folder, asked) || hasDotSegment(folder, asked)) return undefined;
  const real = await DISK.realpath(asked).catch(() => undefined);
  return real !== undefined && isInside(folder, real) && !hasDotSegment(folder, real) && (await DISK.isFile(real)) ? real : undefined;
}

// A refusal: 404 with no body, so an unknown token, an escape, a folder and a missing file look the same. The debug line names the method
// alone: the token is a capability and the path is the design's
function refuseFrame(req: Request, res: Response, log: FrameDeps['log']): void {
  log.debug(`refused design frame: ${req.method}`);
  if (res.headersSent) return void res.destroy(); // a send that failed midway: no second answer on the same response
  res.status(HTTP_NOT_FOUND).set('content-security-policy', REFUSED_POLICY).end();
}

// ponytail: the whole file is read into memory, which is fine for a design's pages, styles and images; stream it if designs ever carry large media
async function serveFrame(req: Request, res: Response, { tokens, log }: FrameDeps): Promise<void> {
  // no-store: the pane reloads on a version change and must get the new file; no-referrer: the token never leaves in a Referer
  res.set({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  const token = String(req.params.token);
  const folder = tokens.folderOf(token);
  const segments: unknown = req.params.path; // Express 5's *path: the decoded segments
  const file = folder === undefined ? undefined : await servedFile(folder, Array.isArray(segments) ? segments.map(String) : [String(segments)]);
  if (file === undefined) return refuseFrame(req, res, log);
  const bytes = await readFile(file);
  res.set('content-security-policy', framePolicy(String(req.headers.host), token)).type(extname(file)); // the Host check already ran
  const isHtml = res.get('content-type')?.startsWith('text/html') === true;
  res.send(isHtml ? withBridge(bytes.toString('utf8')) : bytes);
}

/** GET /design-frame/:token/*path (#108): read-only, never a listing. server.ts mounts it after the Host check and before the secret. */
export function registerDesignFrameRoute(app: Express, deps: FrameDeps): void {
  app.get(`${DESIGN_FRAME_PREFIX}:token/*path`, async (req: Request, res: Response) => {
    try {
      await serveFrame(req, res, deps);
    } catch {
      refuseFrame(req, res, deps.log); // a file gone between the check and the read: the same 404, with nothing about it in the answer
    }
  });
}

// The frame URL of the activity's design: located as the editor locates its file, then refused unless it is a Hive design inside the
// activity's folder (locate has no inside check, #697). A design at the folder's root is refused too: its token would serve the whole checkout
// where designs belong in their own <designsDir>/<date>-<slug>/ folder
async function frameUrl(current: Live, id: string, path: unknown, tokens: DesignFrameTokens): Promise<{ url: string } | Refusal> {
  const located = await locate(current, id, path);
  if ('status' in located) return located;
  if (!located.file.endsWith(DESIGN_SUFFIX)) return { status: HTTP_BAD_REQUEST, message: NOT_DESIGN_MESSAGE };
  const folder = await DISK.realpath(located.folder).catch(() => undefined); // locate's file is real; its folder may not be (macOS's tmpdir)
  if (folder === undefined || !isInside(folder, located.file) || dirname(located.file) === folder) return { status: HTTP_NOT_FOUND, message: MISSING_FILE_MESSAGE };
  return { url: `${DESIGN_FRAME_PREFIX}${tokens.mint(dirname(located.file))}/${encodeURIComponent(basename(located.file))}` };
}

/** GET /activities/:id/design-frame?path= (#108): behind the secret gate and requireLive, like the editor's file routes; read-only and idempotent. */
export function registerDesignFrameMint(app: Express, { requireLive, tokens }: MintDeps): void {
  app.get('/activities/:id/design-frame', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    try {
      const answer = await frameUrl(current, activityParam(req), req.query.path, tokens);
      if ('status' in answer) res.status(answer.status).json({ error: answer.message });
      else res.json(answer);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
