// The process table on win32 (#638): Windows has no pgrep, pkill or lsof, so one PowerShell listing of Win32_Process answers what they answer
// elsewhere. The parser and the helpers are pure, so node --test covers them on every OS; only the listing itself needs Windows.
import { powerShell } from './platform-commands.js';
import type { Exec } from './types.js';

export interface ProcessRow { readonly pid: number; readonly ppid: number; readonly line: string }

// The whole table can pass execFile's default 1 MiB once browsers and Electron apps run, whose command lines are long
const LIST_MAX_BUFFER = 64 * 1024 * 1024;
// A WMI query stuck on an antivirus scan must not hold the boot's killStrays forever. The script calls no cmdlet (#970): a cold 5.1 spent
// this whole bound autoloading CimCmdlets and Microsoft.PowerShell.Utility for Get-CimInstance, Select-Object and ConvertTo-Json.
const LIST_TIMEOUT_MS = 15_000;
// One `<pid> <ppid> <base64 of the UTF-8 command line>` line per process, the last field empty for a null CommandLine: base64 keeps a
// command line's spaces, tabs and line breaks out of the separators
const LISTING = [
  "$ErrorActionPreference = 'Stop'", // a WMI failure exits non-zero, so the exec rejects instead of printing nothing
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', // keeps 5.1's stdout UTF-8, though every field it prints is ASCII now
  '$utf8 = [System.Text.Encoding]::UTF8',
  "foreach ($p in ([wmisearcher]'SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process').Get()) {",
  "  $line = ''",
  "  if ($null -ne $p['CommandLine']) { $line = [Convert]::ToBase64String($utf8.GetBytes([string]$p['CommandLine'])) }",
  "  [Console]::Out.WriteLine(('{0} {1} {2}' -f $p['ProcessId'], $p['ParentProcessId'], $line))",
  '}',
];

const ROW = /^(\d+) (\d+) ([A-Za-z0-9+/]*={0,2})$/;

/** The listing's rows, one per line. A null CommandLine is a process the user cannot read: kept, with no line to match. A line that is not
 *  `<pid> <ppid> <base64>` is skipped, so malformed output is no rows. */
export function parseProcesses(stdout: string): ProcessRow[] {
  // 5.1 may write UTF-8's byte order mark before the first line
  return stdout.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((text) => {
    const match = ROW.exec(text);
    if (match === null) return [];
    const [, pid, ppid, line] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), line: Buffer.from(line, 'base64').toString('utf8') }];
  });
}

// Started from pwsh 7, PSModulePath names 7's modules first and 5.1 fails to load them (as home-acl.ts found when it still used Get-Acl): 5.1 uses its own
const withoutPsModulePath = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));

/** One listing of the whole table through the caller's exec (no cache, #638 decision 3); it rejects when the exec does. */
export async function listProcesses(exec: Exec, env: NodeJS.ProcessEnv = process.env): Promise<ProcessRow[]> {
  const [file, args] = powerShell(LISTING);
  const { stdout } = await exec(file, [...args], { maxBuffer: LIST_MAX_BUFFER, timeout: LIST_TIMEOUT_MS, env: withoutPsModulePath(env) });
  return parseProcesses(stdout);
}

/** The direct children of `pid`, ascending. Never `pid` itself: the System Idle Process is its own parent. */
export const childrenOf = (rows: readonly ProcessRow[], pid: number): number[] =>
  rows.filter((row) => row.ppid === pid && row.pid !== pid).map((row) => row.pid).sort((a, b) => a - b);

/** The rows whose line matches, read as pgrep -f reads its pattern. */
export function matching(rows: readonly ProcessRow[], pattern: string): ProcessRow[] {
  const regex = new RegExp(pattern);
  return rows.filter((row) => regex.test(row.line));
}

/** Every row under `pid`, level by level. A row `isPruned` accepts is left out with all it holds. Windows reuses the pid of a process that
 *  exited while its children still name it as their parent, so a ppid can loop back: each pid is visited once. */
export function subtree(rows: readonly ProcessRow[], pid: number, isPruned: (row: ProcessRow) => boolean): ProcessRow[] {
  const seen = new Set([pid]);
  const found: ProcessRow[] = [];
  let level = [pid];
  while (level.length > 0) {
    const parents = level;
    const next = rows.filter((row) => parents.includes(row.ppid) && !seen.has(row.pid) && !isPruned(row));
    for (const row of next) seen.add(row.pid);
    found.push(...next);
    level = next.map((row) => row.pid);
  }
  return found;
}
