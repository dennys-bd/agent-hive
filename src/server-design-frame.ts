// The design pane's frame (#108): an authenticated call mints a URL for one Hive design of an activity, and a read-only route serves that
// design's folder under the URL's token, outside the secret gate. A sandboxed frame has an opaque origin and no usable credential, so the
// token is the capability and the route never reads the port's cookie. Every answer carries its own sandboxing policy.
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, posix, relative, resolve, sep } from 'node:path';
import type { Express, Request, Response } from 'express';
import { activityParam } from './activity-routes.js';
import { bridgeScript } from './design-bridge.js';
import { assemble, gitBlob, gitEntry, isRegularBlob, OUTPUT_MAX, readPartFrom, readPartFromGit, type ReadPart } from './design-parts.js';
import { isInside } from './ide.js';
import type { Logger } from './log.js';
import { DESIGN_FRAME_PREFIX, newSecret } from './secret.js';
import { type Located, locate } from './server-editor.js';
import { baseCommit } from './server-file-base.js';
import { DISK, MISSING_FILE_MESSAGE } from './server-files.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import type { Exec } from './types.js';
import { toWire } from './wire-path.js';

const HEAD_TAG = /<head\b[^>]*>/i; // \b: <header> is not <head>
const FIRST_ELEMENT = /<[a-z]/i; // a doctype or a comment is not an element: the bridge never lands before it
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const DESIGN_SUFFIX = '.hv.html';
const HTML_FILE = /\.html?$/i;
const BLOB_MAX = 64 * 1024 * 1024; // ponytail: a before frame's asset is read whole into memory; stream it if designs carry larger media
const NOT_DESIGN_MESSAGE = 'not a Hive design';
// A refusal is for no folder the route serves, so it gets the tightest policy rather than one naming the asked token
const REFUSED_POLICY = "sandbox; default-src 'none'; frame-ancestors 'self'";

type Live = NonNullable<ReturnType<TaskRouteDeps['requireLive']>>;
interface FrameDeps { tokens: DesignFrameTokens; log: Pick<Logger, 'debug'> }
interface MintDeps { requireLive: TaskRouteDeps['requireLive']; tokens: DesignFrameTokens; exec: Exec }

/** A before frame's folder (#675): `folder` of `commit` in the repository at `top`, in git's path space (posix, relative to top). */
export interface BaseFolder { top: string; commit: string; folder: string }

/** This boot's design frame tokens (#108, #675). Minting a value again answers its token, so a map stays bounded by what the user opened.
 *  Memory only: a restart voids every URL. */
export interface DesignFrameTokens {
  mint(folder: string): string; folderOf(token: string): string | undefined;
  mintBase(base: BaseFolder): string; baseOf(token: string): BaseFolder | undefined;
}

function tokenMap<T>(keyOf: (value: T) => string): { mint(value: T): string; of(token: string): T | undefined } {
  const byToken = new Map<string, T>();
  const byKey = new Map<string, string>();
  return {
    mint(value) {
      const key = keyOf(value);
      const held = byKey.get(key);
      if (held !== undefined) return held;
      const token = newSecret(); // 32 random bytes in hex, as the boot's own secret
      byToken.set(token, value);
      byKey.set(key, token);
      return token;
    },
    of: (token) => byToken.get(token),
  };
}

export function createDesignFrameTokens(): DesignFrameTokens {
  const folders = tokenMap<string>((folder) => folder);
  const bases = tokenMap<BaseFolder>(({ top, commit, folder }) => JSON.stringify([top, commit, folder]));
  return { mint: folders.mint, folderOf: folders.of, mintBase: bases.mint, baseOf: bases.of };
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

/** The page with the bridge first in its <head>, else before its first element (#108): it runs before the design's own scripts. parts: what
 *  the screen was assembled from (#421), which the bridge reports to the pane. */
export function withBridge(html: string, parts: readonly string[] = []): string {
  const head = HEAD_TAG.exec(html);
  const at = head ? head.index + head[0].length : Math.max(html.search(FIRST_ELEMENT), 0);
  return `${html.slice(0, at)}${bridgeScript(parts)}${html.slice(at)}`;
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

// A screen is assembled from its parts before the bridge goes in (#421); any other page, a part asked directly included, is served as stored.
// screen: its path from the token's folder; read: the disk's reader or the commit's (#675)
async function pageOf(screen: string, text: string, read: ReadPart): Promise<string> {
  if (!screen.endsWith(DESIGN_SUFFIX)) return withBridge(text);
  const { html, parts } = await assemble(screen, text, read);
  return withBridge(html, parts);
}

interface Served { name: string; bytes: Buffer; page(): Promise<string> }

async function diskServed(folder: string, segments: string[]): Promise<Served | undefined> {
  const file = await servedFile(folder, segments);
  if (file === undefined) return undefined;
  const bytes = await readFile(file);
  return { name: file, bytes, page: () => pageOf(toWire(relative(folder, file), process.platform), bytes.toString('utf8'), readPartFrom(folder)) };
}

// The asked file of a before frame (#675): joined under the token's folder in git's path space and refused, as servedFile refuses, for an
// escape or a dot segment before git is asked; then only a regular blob within its cap, so a link, a tree or a huge blob is never read. A
// page is held to OUTPUT_MAX, as its assembly is; an asset (an image, a video) to BLOB_MAX, since the disk route serves one of any size
async function servedBlob({ top, commit, folder }: BaseFolder, segments: string[]): Promise<Served | undefined> {
  const path = posix.join(folder, ...segments);
  const screen = posix.relative(folder, path);
  if (screen === '' || screen.split('/').some((part) => part.startsWith('.'))) return undefined; // '..' is a dot segment too
  const entry = await gitEntry(top, commit, path);
  const cap = HTML_FILE.test(path) ? OUTPUT_MAX : BLOB_MAX;
  if (entry === undefined || !isRegularBlob(entry) || entry.size > cap) return undefined;
  const bytes = await gitBlob(top, entry.oid, cap).catch(() => undefined); // a blob gone or grown past the cap since ls-tree: the bare 404
  if (bytes === undefined) return undefined;
  return { name: path, bytes, page: () => pageOf(screen, bytes.toString('utf8'), readPartFromGit(top, commit, folder)) };
}

async function servedOf(tokens: DesignFrameTokens, token: string, segments: string[]): Promise<Served | undefined> {
  const folder = tokens.folderOf(token);
  if (folder !== undefined) return diskServed(folder, segments);
  const base = tokens.baseOf(token);
  return base === undefined ? undefined : servedBlob(base, segments);
}

// ponytail: the whole file is read into memory, which is fine for a design's pages, styles and images; stream it if designs ever carry large media
async function serveFrame(req: Request, res: Response, { tokens, log }: FrameDeps): Promise<void> {
  // no-store: the pane reloads on a version change and must get the new file; no-referrer: the token never leaves in a Referer
  res.set({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  const token = String(req.params.token);
  const segments: unknown = req.params.path; // Express 5's *path: the decoded segments
  const served = await servedOf(tokens, token, Array.isArray(segments) ? segments.map(String) : [String(segments)]);
  if (served === undefined) return refuseFrame(req, res, log);
  res.set('content-security-policy', framePolicy(String(req.headers.host), token)).type(extname(served.name)); // the Host check already ran
  const isHtml = res.get('content-type')?.startsWith('text/html') === true;
  res.send(isHtml ? await served.page() : served.bytes);
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

type MintAnswer = { url: string } | { missing: true } | Refusal;
const NOT_FOUND: Refusal = { status: HTTP_NOT_FOUND, message: MISSING_FILE_MESSAGE };

// Both mints' refusals (#108, #675): not a Hive design, outside the activity's folder (locate has no inside check, #697), or at the folder's
// root, where a token would serve the whole checkout. Answers the real folder the design sits in
async function designFolder(located: Located): Promise<{ folder: string } | Refusal> {
  if (!located.file.endsWith(DESIGN_SUFFIX)) return { status: HTTP_BAD_REQUEST, message: NOT_DESIGN_MESSAGE };
  const folder = await DISK.realpath(located.folder).catch(() => undefined); // locate's file is real; its folder may not be (macOS's tmpdir)
  if (folder === undefined || !isInside(folder, located.file) || dirname(located.file) === folder) return NOT_FOUND;
  return { folder: dirname(located.file) };
}

// The frame URL of the activity's design: located as the editor locates its file, then refused by designFolder
async function frameUrl(current: Live, id: string, path: unknown, tokens: DesignFrameTokens): Promise<MintAnswer> {
  const located = await locate(current, id, path);
  if ('status' in located) return located;
  const design = await designFolder(located);
  if ('status' in design) return design;
  return { url: `${DESIGN_FRAME_PREFIX}${tokens.mint(design.folder)}/${encodeURIComponent(basename(located.file))}` };
}

// The before frame's URL (#675): the base as file-base resolves it, at a sha; missing when that commit has no such screen. A screen at the
// repository's root is refused like one at the folder's root
async function baseFrameUrl(current: Live, req: Request, { tokens, exec }: Pick<MintDeps, 'tokens' | 'exec'>): Promise<MintAnswer> {
  const base = await baseCommit(current, activityParam(req), req.query.path, req.query.against, exec);
  if ('status' in base) return base;
  const design = await designFolder(base.located);
  if ('status' in design) return design;
  if (base.repo === undefined) return NOT_FOUND;
  const { top, commit } = base.repo;
  const path = toWire(base.repo.path, process.platform); // git's path space
  const folder = posix.dirname(path);
  if (folder === '.') return NOT_FOUND;
  const entry = commit === undefined ? undefined : await gitEntry(top, commit, path);
  if (commit === undefined || entry === undefined || !isRegularBlob(entry)) return { missing: true };
  return { url: `${DESIGN_FRAME_PREFIX}${tokens.mintBase({ top, commit, folder })}/${encodeURIComponent(posix.basename(path))}` };
}

function registerMint(app: Express, route: string, requireLive: MintDeps['requireLive'], answerOf: (current: Live, req: Request) => Promise<MintAnswer>): void {
  app.get(route, async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    try {
      const answer = await answerOf(current, req);
      if ('status' in answer) res.status(answer.status).json({ error: answer.message });
      else res.json(answer);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** GET /activities/:id/design-frame?path= (#108) and GET /activities/:id/design-frame-base?path=&against=head|task (#675): behind the secret
 *  gate and requireLive, like the editor's file routes; read-only and idempotent. */
export function registerDesignFrameMint(app: Express, { requireLive, tokens, exec }: MintDeps): void {
  registerMint(app, '/activities/:id/design-frame', requireLive, (current, req) => frameUrl(current, activityParam(req), req.query.path, tokens));
  registerMint(app, '/activities/:id/design-frame-base', requireLive, (current, req) => baseFrameUrl(current, req, { tokens, exec }));
}
