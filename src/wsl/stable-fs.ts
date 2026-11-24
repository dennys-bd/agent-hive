// The WSL machine's fs (#945): every member waits for the helper and calls the fs of the link it is on now, so a caller that holds the
// machine across a restart never sees the swap. The overloaded members forward the form they were called with.
import type { BigIntStats, Dirent, Stats } from 'node:fs';
import type { Machine, MachineFs } from '../machine.js';

type Disk = () => Promise<MachineFs>;

function overloaded(disk: Disk): Pick<MachineFs, 'lstat' | 'readdir' | 'readFile' | 'readLines'> {
  function lstat(path: string): Promise<Stats>;
  function lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  async function lstat(path: string, options?: { bigint: true }): Promise<Stats | BigIntStats> {
    const fs = await disk();
    return options === undefined ? fs.lstat(path) : fs.lstat(path, options);
  }
  function readdir(path: string): Promise<string[]>;
  function readdir(path: string, options: { withFileTypes: true; recursive?: boolean }): Promise<Dirent[]>;
  async function readdir(path: string, options?: { withFileTypes: true; recursive?: boolean }): Promise<string[] | Dirent[]> {
    const fs = await disk();
    return options === undefined ? fs.readdir(path) : fs.readdir(path, options);
  }
  function readFile(path: string, options: { maxBytes: number; encoding: BufferEncoding }): Promise<string>;
  function readFile(path: string, options: { maxBytes: number }): Promise<Buffer>;
  async function readFile(path: string, { maxBytes, encoding }: { maxBytes: number; encoding?: BufferEncoding }): Promise<string | Buffer> {
    const fs = await disk();
    return encoding === undefined ? fs.readFile(path, { maxBytes }) : fs.readFile(path, { maxBytes, encoding });
  }
  // a start that fails rejects the first next(), as the unavailable machine's readLines does
  async function* readLines(path: string, options: { maxBytes: number }): AsyncGenerator<string> {
    yield* (await disk()).readLines(path, options);
  }
  return { lstat, readdir, readFile, readLines };
}

export function stableFs(on: () => Promise<Machine>): MachineFs {
  const disk: Disk = async () => (await on()).fs;
  return {
    ...overloaded(disk),
    stat: async (path) => (await disk()).stat(path),
    realpath: async (path) => (await disk()).realpath(path),
    access: async (path, mode) => (await disk()).access(path, mode),
    writeFile: async (path, data, options) => (await disk()).writeFile(path, data, options),
    writeAtomic: async (path, text) => (await disk()).writeAtomic(path, text),
    mkdir: async (path, options) => (await disk()).mkdir(path, options),
    mkdtemp: async (prefix) => (await disk()).mkdtemp(prefix),
    rename: async (from, to) => (await disk()).rename(from, to),
    rm: async (path, options) => (await disk()).rm(path, options),
    cp: async (from, to, options) => (await disk()).cp(from, to, options),
    copyFile: async (from, to, mode) => (await disk()).copyFile(from, to, mode),
    link: async (existing, created) => (await disk()).link(existing, created),
    chmod: async (path, mode) => (await disk()).chmod(path, mode),
    unlink: async (path) => (await disk()).unlink(path),
    appendFile: async (path, data, options) => (await disk()).appendFile(path, data, options),
  };
}
