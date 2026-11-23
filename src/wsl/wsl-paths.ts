// A distro's paths and their Windows UNC names (#939): the host reaches a distro's disk as \\wsl.localhost\<distro>\..., the distro as /....
import { isDistro } from '../config-machines.js';
import { MachineError, pathsOf } from '../machine.js';

const posix = pathsOf('linux');
const UNC_HOSTS = ['wsl.localhost', 'wsl$'];
const badPath = (p: string): MachineError => new MachineError(`not a path of this distro: ${p}`, { code: MachineError.BAD_PATH });

/** The UNC path of an absolute distro path. A relative one has no place on the host's side, so it is refused. */
export function toWindowsPath(distro: string, p: string): string {
  if (!posix.isAbsolute(p) || !isDistro(distro)) throw badPath(p);
  const segments = posix.normalize(p).split('/').filter(Boolean);
  // a Linux file name may hold a backslash, which Windows reads as a separator: a\..\..\b would climb out of the distro
  if (segments.some((s) => s.includes('\\'))) throw badPath(p);
  return `\\\\wsl.localhost\\${distro}\\${segments.join('\\')}`;
}

/** The distro path of a UNC path of that distro, normalized. Anything else is refused: another distro, a local path, a .. above the root. */
export function toDistroPath(distro: string, unc: string): string {
  const [empty1, empty2, host, share, ...rest] = unc.split(/[\\/]/);
  const isUnc = /^\\\\/.test(unc) && empty1 === '' && empty2 === '';
  if (!isUnc || !UNC_HOSTS.includes((host ?? '').toLowerCase()) || (share ?? '').toLowerCase() !== distro.toLowerCase()) throw badPath(unc);
  // posix.normalize swallows a .. at the root, so the walk is by hand: a .. with nothing above it is an escape
  const kept: string[] = [];
  for (const segment of rest) {
    if (segment === '..') {
      if (kept.pop() === undefined) throw badPath(unc);
    } else if (segment !== '' && segment !== '.') kept.push(segment);
  }
  return `/${kept.join('/')}`;
}
