// The viewer's side of the daemon secret (#467): the main window's page cannot set a header on GET /, its assets, EventSource or the pty
// WebSocket, but the browser sends a cookie on all of them. Electron's session is injected (a thunk: it exists only after app ready), so
// node:test covers this without Electron.
import type { DaemonAddress } from './daemon.js';
import { COOKIE_PREFIX, secretCookie } from './secret.js';

const HOST = '127.0.0.1';
const OUR_COOKIE = new RegExp(`^${COOKIE_PREFIX}\\d+$`); // hive_secret_<port>

/** The fields of Electron's CookiesSetDetails this sets: no expirationDate, so a session cookie. */
export interface CookieDetails {
  url: string;
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: 'strict';
  path: string;
}

/** The part of session.defaultSession.cookies this needs. */
export interface CookieJar {
  get(filter: { url: string }): Promise<{ name: string; domain?: string }[]>;
  remove(url: string, name: string): Promise<void>;
  set(details: CookieDetails): Promise<void>;
}

export interface ViewerAuth {
  /** Makes `daemon.port` the only port the viewer talks to: every window of another port closed, every other port's cookie removed, then
   *  the probed secret set as this port's cookie, before a page of it loads. The pair comes from one probe: hive.secret is never read here,
   *  so a reboot in between cannot pair the port with another boot's secret. Resolves true when the value is new for that port: a page
   *  already open there holds a stale cookie, and its EventSource, refused with 403, never retries. */
  authorize(daemon: DaemonAddress): Promise<boolean>;
  /** The secret authorize last set, and only for the port it set it on: a main window and its detached windows talk to their own port, and no other port's
   *  windows are left open to need one. */
  secretOf(port: number): string | undefined;
}

// A cookie ignores the port, so every hive_secret_<port> in the session goes to every port of 127.0.0.1 (#467): once the daemon moved, the
// old port may be another account's, and a window still open there (an EventSource retry, a click, a reload) would hand it the new secret.
// Closing those windows before the cookies go, and both before the new one is set, leaves nothing on the old port to send it.
export function createViewerAuth(jar: () => CookieJar, closeOtherPorts: (port: number) => void): ViewerAuth {
  let current: DaemonAddress | undefined; // what this viewer last set: a repeat costs no IPC and reloads nothing
  const removeOtherCookies = async (port: number): Promise<void> => {
    // By URL, not { domain }: a domain filter need not match the host-only cookies set() makes
    const ours = (await jar().get({ url: `http://${HOST}` })).filter(({ domain }) => domain === undefined || domain === HOST);
    const names = new Set(ours.map(({ name }) => name));
    const others = [...names].filter((name) => OUR_COOKIE.test(name) && name !== secretCookie(port));
    for (const name of others) await jar().remove(`http://${HOST}:${name.slice(COOKIE_PREFIX.length)}`, name);
  };
  const run = async ({ port, secret }: DaemonAddress): Promise<boolean> => {
    closeOtherPorts(port);
    await removeOtherCookies(port);
    if (current?.port === port && current.secret === secret) return false;
    current = undefined; // until the new cookie is in: a failed set leaves no window a secret to send
    // HttpOnly keeps the value out of the page's JavaScript; SameSite=Strict keeps it off requests from other sites (#467)
    await jar().set({ url: `http://${HOST}:${port}`, name: secretCookie(port), value: secret, httpOnly: true, sameSite: 'strict', path: '/' });
    current = { port, secret };
    return true;
  };
  // One at a time: a stale authorize(P) interleaving with authorize(Q) could close Q's windows or set P's cookie after Q's. A rejected one
  // leaves the chain usable.
  let queue: Promise<unknown> = Promise.resolve();
  const authorize = (daemon: DaemonAddress): Promise<boolean> => {
    const next = queue.then(() => run(daemon));
    queue = next.catch(() => undefined);
    return next;
  };
  return { authorize, secretOf: (port) => (current?.port === port ? current.secret : undefined) };
}
