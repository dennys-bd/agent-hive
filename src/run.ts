import { releaseLock, removeDaemonSecret } from './daemon-files.js';
import { bootHive } from './hive.js';
import { hiveHome } from './home.js';
import { homeLog } from './home-log.js';
import { localeEnv, readSystemLang, SYSTEM_READS } from './locale-env.js';
import { readPlanLimits } from './plan-limits.js';
import pty from 'node-pty';
import type { SpawnPty } from './pty-host.js';

// One Hive per home, so there is nothing to name: the home is ${XDG_CONFIG_HOME:-~/.config}/agent-hive, or HIVE_HOME itself when set (#202, #310).
const log = homeLog(); // #742: a daemon started from the Dock has no terminal to read its errors in
if (process.argv.length > 2) {
  log.error('uso: node dist/src/run.js');
  process.exit(2);
}

// Set by the launcher so an Electron execPath runs this file as plain Node. The workers must not inherit it: any Electron
// binary they start (`hive` itself, from a worker on this repo) would run as Node too and crash on `app`. HIVE_LOCALE is the viewer's
// app.getLocale() (#242): a Hive opened from Finder has no LANG, so the boot takes the system language from it; the workers get neither.
// What the Finder leaves out is filled from the system instead, so every pty runs under a UTF-8 locale (#667).
const { ELECTRON_RUN_AS_NODE: _runAsNode, HIVE_LOCALE: locale, ...cleanEnv } = process.env;
process.env = { ...cleanEnv, ...localeEnv(cleanEnv, process.platform, readSystemLang(process.platform, SYSTEM_READS)) };

// The daemon's ptys (#251). node-pty is N-API, so the binary built for Electron loads here too, under ELECTRON_RUN_AS_NODE or plain node.
const spawnPty: SpawnPty = (file, args, { cwd, env, cols, rows }) => pty.spawn(file, args, { name: 'xterm-256color', cwd, env, cols, rows });

// POST /stop, SIGTERM and SIGINT all end here: close() kills every worker and drops the port, then the process exits. The first
// call owns the shutdown; a second one while it runs joins it. A signal between listen() and the end of the boot waits for the
// boot, so what poll() already spawned is killed too; a boot that fails is reported by its own catch below, not here.
// A failed close or a second signal exits without releaseLock: the exit closes the lock helper's pipe, which releases the lock (#479)
let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  void booted.then(
    ({ server }) => server.close(reason).then(() => {
      removeDaemonSecret(hiveHome()); // before releaseLock, whose pid it checks (#467): a stopped daemon leaves no secret behind
      releaseLock(hiveHome()); // a clean stop frees the home (#466); hive.port stays: it is the next boot's first try
      process.exit(0);
    }, (err: Error) => {
      log.error(`close failed: ${err.message}`);
      process.exit(1);
    }),
    () => undefined,
  );
}

// A second signal while the shutdown runs (a boot stuck in gh, a worker that ignores its kill) is the way out without a SIGKILL.
const onSignal = (): void => (stopping ? process.exit(1) : shutdown('signal'));
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
// hiveHome() inside the promise: a relative HIVE_HOME (#310) throws, and the catch below turns it into one line instead of a stack trace
const booted = Promise.resolve().then(() => bootHive(hiveHome(), { readPlanLimits, onStop: () => shutdown('stop'), spawnPty, ...(locale ? { locale } : {}) })); // none or '': the Node locale
booted.catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
