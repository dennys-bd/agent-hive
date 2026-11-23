import { type Machine, pathsOf } from '../../src/machine.js';

/** A fake disk in `platform`'s flavour, the same on every host (#929): the root holds a.ts, sub/ and link, a symlink to a folder outside the
 *  root that holds b.ts; x.ts sits beside the root. realpath follows the link, every other held path is its own real path. */
export interface LinkedDisk {
  paths: Machine['paths'];
  root: string;
  outside: string;
  at(...parts: string[]): string;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  isFile(path: string): Promise<boolean>;
}

export function linkedDisk(platform: NodeJS.Platform): LinkedDisk {
  const paths = pathsOf(platform);
  const [root, outside] = platform === 'win32' ? ['C:\\root', 'D:\\elsewhere'] : ['/root', '/elsewhere'];
  const at = (...parts: string[]): string => paths.join(root, ...parts);
  const link = at('link');
  const real = (path: string): string => (path === link || path.startsWith(`${link}${paths.sep}`) ? paths.join(outside, paths.relative(link, path)) : path);
  const folders = new Set([root, at('sub'), outside]);
  const files = new Set([at('a.ts'), paths.join(outside, 'b.ts'), paths.resolve(root, '..', 'x.ts')]);
  const isHeld = (path: string): boolean => folders.has(path) || files.has(path);
  return {
    paths, root, outside, at,
    realpath: async (path) => {
      const resolved = real(path);
      if (!isHeld(resolved)) throw new Error(`ENOENT: ${path}`);
      return resolved;
    },
    // lstat's view: the link itself exists and is no folder
    stat: async (path) => {
      if (!isHeld(path) && path !== link) throw new Error(`ENOENT: ${path}`);
      return { isDirectory: () => folders.has(path) };
    },
    isFile: async (path) => files.has(path),
  };
}
