// The draw.io webapp (#955): the pinned editor scripts/fetch-drawio.mjs unpacks into vendor/drawio/, served read-only outside the secret
// gate for the diagram pane's sandboxed frame (#956). That frame has an opaque origin and presents no credential, and the files are public
// third-party code with no user data, so the route needs no token: only its own sandboxing policy on every answer, 404s included.
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { DRAWIO_PREFIX } from './secret.js';

const HTTP_NOT_FOUND = 404;

/** vendor/drawio resolved from dist/src/, as pluginSource finds assets/plugin: the same path in a checkout and in the unpacked installer. */
export const DRAWIO_ROOT = fileURLToPath(new URL('../../vendor/drawio', import.meta.url));

/** The route's policy (#955). `sandbox allow-scripts`, never allow-same-origin: an opaque origin with no way to the port's cookie or the
 *  daemon's API. connect-src names the route ('self' is unreliable in an opaque origin), so even a script draw.io loads cannot reach the API
 *  or another port. frame-ancestors stops another local port framing it, as on /design-frame/. */
export function drawioPolicy(host: string): string {
  return ['sandbox allow-scripts', `connect-src http://${host}${DRAWIO_PREFIX}`, "frame-ancestors 'self'"].join('; ');
}

function sandbox(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'content-security-policy': drawioPolicy(String(req.headers.host)), // the Host check already ran
    'access-control-allow-origin': '*', // draw.io's own XHR (stencils, resources) comes from the frame's null origin
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  next();
}

/** GET /drawio/*path (#955): read-only, never a listing or a redirect. server.ts mounts it after the Host check and before the secret. */
export function registerDrawioRoute(app: Express, { root }: { root: string }): void {
  const files = express.static(root, { index: false, redirect: false, dotfiles: 'ignore', fallthrough: true });
  // whatever static did not answer, the 403 send gives an encoded .. included (fallthrough turns a 4xx into next()): the same bare 404
  app.use(DRAWIO_PREFIX, sandbox, files, (_req: Request, res: Response) => void res.status(HTTP_NOT_FOUND).end());
}
