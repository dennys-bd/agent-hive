import { win32 } from 'node:path';

// The wire's relative paths (#641): the daemon keeps its paths native, and every relative path a route answers crosses with `/` alone, so the
// UI splits on `/` on every OS. The only place a separator is replaced. The platform is a parameter, so node:test covers win32 on any OS;
// off win32 a `\` is a legal character of a file name and must survive.
export function toWire(relative: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? relative.split(win32.sep).join('/') : relative;
}
