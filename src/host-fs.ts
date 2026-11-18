// The host's own disk and facts in the machine's shape (#160), for callers with no activity, so no machine to ask: the Hive's own tools
// (editor-install, worker-lsp), and until their nodes give them a machine, lsp-host's project copy (7.4) and the evaluate stage's patch
// (server-evaluate). A caller that has an activity asks machineFor instead. Host-only in biome.jsonc.
import { access, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { envValue } from './exec-path.js';
import type { MachineFs, MachineInfo } from './machine.js';

export interface HostSide {
  fs: Pick<MachineFs, 'access' | 'stat' | 'mkdtemp' | 'copyFile' | 'rm'>;
  info(): Pick<MachineInfo, 'platform' | 'path' | 'tmpdir'>;
}

// #806: win32's env names ignore case, as the local machine's info reads them
export const HOST: HostSide = {
  fs: { access, stat, mkdtemp, copyFile, rm },
  info: () => ({ platform: process.platform, path: (process.platform === 'win32' ? envValue(process.env, 'PATH') : process.env.PATH) ?? '', tmpdir: tmpdir() }),
};
