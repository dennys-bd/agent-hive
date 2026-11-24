import type { Exec } from '../src/types.js';

/** A Win32_Process row of the listing (#638, #970) */
export interface Listed { pid: number; ppid: number; line: string | null }

export const listed = (pid: number, ppid: number, line: string | null): Listed => ({ pid, ppid, line });

/** The listing's stdout as win-procs.ts's script prints it: `<pid> <ppid> <base64 of the UTF-8 line>`, the last field empty for a null line. */
export const listingText = (rows: readonly Listed[]): string =>
  rows.map(({ pid, ppid, line }) => `${pid} ${ppid} ${line === null ? '' : Buffer.from(line, 'utf8').toString('base64')}\r\n`).join('');

/** A win32 Exec: the PowerShell listing answers `rows`, and every other call (taskkill) is recorded and succeeds. */
export function listingExec(rows: readonly Listed[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    if (/\\powershell\.exe$/i.test(file)) return { stdout: listingText(rows) };
    calls.push([file, ...args]);
    return { stdout: '' };
  };
  return { exec, calls };
}
