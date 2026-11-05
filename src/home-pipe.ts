// The home lock on Windows (#627): the daemon listens on a named pipe whose name derives from its home. Windows frees the pipe when the
// holder process dies, however it dies, so there is no takeover logic. Plain Node, like daemon-files.ts.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

/** The pipe that stands for a home: one name for every spelling of the path (separators, drive letter and folder case). Pure, so it is tested
 *  on every OS. */
export function homePipeName(home: string): string {
  const digest = createHash('sha256').update(path.win32.resolve(home).toLowerCase()).digest('hex');
  return `\\\\.\\pipe\\agent-hive-${digest}`;
}

const servers = new Map<string, Server>();

/** Listens on the home's pipe for this process's lifetime, or rejects with `refuse()` when something already holds it. No lost-lock callback
 *  exists on win32: the posix helper is an outside process someone can kill, and the pipe has none. */
export function holdPipe(home: string, refuse: () => Error): Promise<void> {
  if (servers.has(home)) return Promise.reject(refuse()); // the same process twice: the pipe would say so too, this just never depends on it
  const name = homePipeName(realpathSync.native(home)); // the real path, so a symlinked or 8.3-short spelling of the home is the same lock
  const server = createServer((socket) => socket.destroy()); // nobody talks over it: connecting only proves the pipe is held
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? refuse() : new Error(`Agent Hive não pegou o pipe ${name}: ${err.message}`));
    });
    server.listen(name, () => {
      server.removeAllListeners('error');
      server.on('error', () => undefined); // a later error must not crash the daemon: the pipe is already held
      server.unref(); // held for the daemon's lifetime, never the reason its event loop stays alive
      servers.set(home, server);
      resolve();
    });
  });
}

/** Closes the home's pipe; resolves once Windows has freed it. undefined for a home this process does not hold. */
export function closePipe(home: string): Promise<void> | undefined {
  const server = servers.get(home);
  if (server === undefined) return undefined;
  servers.delete(home);
  server.ref(); // until closed: the next acquireLock awaits this, and an empty event loop would end the wait early
  return new Promise((resolve) => server.close(() => resolve()));
}
