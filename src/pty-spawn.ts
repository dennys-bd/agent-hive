// node-pty's spawn as the daemon hands it to the pty host (#251), out of run.ts, which boots the Hive when imported, so the Windows lane
// drives this same call (#644). No ConPTY option on purpose (#644 decision 1): node-pty 1.1.0 turns ConPTY on by itself from Windows build
// 18309, even useConpty cannot turn it on below that, useConptyDll is experimental, and conptyInheritCursor would hold the first draw until
// a tab answers the cursor query. node-pty is N-API, so the binary built for Electron loads here too, under ELECTRON_RUN_AS_NODE or plain node.
import pty from 'node-pty';
import { releasedOnExit, type SpawnPty } from './pty-host.js';

export const nodePtySpawn: SpawnPty = (file, args, { cwd, env, cols, rows }) =>
  releasedOnExit(pty.spawn(file, args, { name: 'xterm-256color', cwd, env, cols, rows }), process.platform);
