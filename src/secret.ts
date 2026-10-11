// The daemon's per-boot secret (#467): every HTTP request and every pty upgrade carries it, by the x-hive-secret header (the CLI, the menu
// bar, the workers) or by the port's cookie (the viewer's pages, which cannot set a header on GET /, its assets, EventSource or a
// WebSocket). Plain Node: the server, the pty socket and the launcher (daemon.ts) share it, and the launcher must not pull Express in.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SECRET_HEADER = 'x-hive-secret';
const SECRET_BYTES = 32; // 64 hex characters: safe in a header, a cookie and a shell variable without escaping
export const COOKIE_PREFIX = 'hive_secret_'; // the viewer finds its cookies by it (#467)

/** The design frame route's mount (#108): the only source the pages may frame. */
export const DESIGN_FRAME_PREFIX = '/design-frame/';

/** The pages' Content-Security-Policy (#467). A cookie ignores the port and SameSite counts every port of 127.0.0.1 as the same site, so
 *  an http:// image in an issue's markdown pointing at another local port would carry this port's cookie there: images and media only
 *  load from this origin or over https (GitHub's attachments), connections stay on this origin ('self' covers its ws:// in Chromium).
 *  Scripts and styles are left alone: Vite's build output and xterm's inline styles need nothing restricted there. Frames (#108): only the
 *  design frame route, on both hosts the Host check allows; a path-restricted source is the only way to name one route of this origin, and
 *  it needs the port. */
export const pagePolicy = (port: number): string => {
  const frames = [`http://127.0.0.1:${port}${DESIGN_FRAME_PREFIX}`, `http://localhost:${port}${DESIGN_FRAME_PREFIX}`].join(' ');
  return `img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; frame-src ${frames}; base-uri 'none'`;
};

/** A new secret for one boot: the next boot voids every copy of this one. */
export const newSecret = (): string => randomBytes(SECRET_BYTES).toString('hex');

// timingSafeEqual throws on buffers of different lengths; hashing both sides first gives equal lengths and leaks neither the length nor the
// content of either value
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Whether `presented` is the secret, in constant time. */
export function matchesSecret(secret: string, presented: string | undefined): boolean {
  return presented !== undefined && timingSafeEqual(digest(secret), digest(presented));
}

/** The viewer's cookie for a daemon on `port`: cookies ignore the port, so the name carries it, or a test Hive beside the installed one
 *  (HIVE_HOME) would overwrite the other's cookie on 127.0.0.1. */
export const secretCookie = (port: number): string => `${COOKIE_PREFIX}${port}`;

// One cookie's value out of a Cookie header; undefined when it is not there
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const pair of (header ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/** The secret a request presents: the x-hive-secret header when it has one (no client sends both), else the cookie of this port. */
export function presentedSecret(req: Pick<IncomingMessage, 'headers'>, port: number): string | undefined {
  const header = req.headers[SECRET_HEADER];
  return typeof header === 'string' ? header : cookieValue(req.headers.cookie, secretCookie(port));
}
