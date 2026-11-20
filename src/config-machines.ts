import { isAbsolute, posix } from 'node:path';
import { LOCAL_MACHINE, type MachineId, WSL_MACHINE_PREFIX } from './types.js';

// A workspace's machine (#931), out of config.ts, which is past 400 lines. Required, no migration: one message for missing and malformed.
const FILE = 'hive.config.json';
const LAST_CONTROL = 0x1f;
const DEL = 0x7f;

// A distro name as `wsl -d` takes it: non-empty, no path separator, no control character
const isDistro = (name: string): boolean =>
  name !== '' && !name.includes('/') && !name.includes('\\') && ![...name].some((c) => c.charCodeAt(0) <= LAST_CONTROL || c.charCodeAt(0) === DEL);

export function parseWorkspaceMachine(raw: unknown, field: string): MachineId {
  if (raw === LOCAL_MACHINE) return raw;
  if (typeof raw === 'string' && raw.startsWith(WSL_MACHINE_PREFIX) && isDistro(raw.slice(WSL_MACHINE_PREFIX.length))) return raw;
  throw new Error(`${FILE}: "${field}.machine" must be "local" or "wsl:<distro>"`);
}

// A distro's disk is Linux, whatever the host: its path is POSIX. A local workspace keeps the host's rule.
export function requireWorkspacePath(raw: unknown, machine: MachineId, field: string): string {
  const absolute = machine.startsWith(WSL_MACHINE_PREFIX) ? posix.isAbsolute : isAbsolute;
  if (typeof raw !== 'string' || !absolute(raw)) throw new Error(`${FILE}: "${field}.path" must be an absolute path`);
  return raw;
}
