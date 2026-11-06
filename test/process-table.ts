import type { Exec } from '../src/types.js';

/** A Win32_Process row as the listing's ConvertTo-Json prints it (#638) */
export interface Listed { ProcessId: number; ParentProcessId: number; CommandLine: string | null }

export const listed = (pid: number, ppid: number, line: string | null): Listed => ({ ProcessId: pid, ParentProcessId: ppid, CommandLine: line });

/** A win32 Exec: the PowerShell listing answers `rows`, and every other call (taskkill) is recorded and succeeds. */
export function listingExec(rows: readonly Listed[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    if (/\\powershell\.exe$/i.test(file)) return { stdout: JSON.stringify(rows) };
    calls.push([file, ...args]);
    return { stdout: '' };
  };
  return { exec, calls };
}
