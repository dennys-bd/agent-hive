// The process table on win32 (#638): Windows has no pgrep, pkill or lsof, so one PowerShell listing of Win32_Process answers what they answer
// elsewhere. The parser and the helpers are pure, so node --test covers them on every OS; only the listing itself needs Windows.
import { powerShell } from './platform-commands.js';
import type { Exec } from './types.js';

export interface ProcessRow { readonly pid: number; readonly ppid: number; readonly line: string }

// The whole table's JSON can pass execFile's default 1 MiB once browsers and Electron apps run, whose command lines are long
const LIST_MAX_BUFFER = 64 * 1024 * 1024;
const NO_PARENT = -1;
const LIST_TIMEOUT_MS = 15_000; // a CIM call stuck on WMI or an antivirus scan must not hold the boot's killStrays forever
const LISTING = [
  "$ErrorActionPreference = 'Stop'", // a CIM failure exits non-zero, so the exec rejects instead of printing nothing
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', // 5.1 prints in the OEM code page otherwise, garbling a non-ASCII path
  'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
];

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

// A null CommandLine is a process the user cannot read: kept, with no line to match
function rowOf(value: unknown): ProcessRow[] {
  if (typeof value !== 'object' || value === null) return [];
  const { ProcessId: pid, ParentProcessId: ppid, CommandLine: line } = value as Record<string, unknown>;
  if (!isInteger(pid)) return [];
  return [{ pid, ppid: isInteger(ppid) ? ppid : NO_PARENT, line: typeof line === 'string' ? line : '' }];
}

/** The listing's rows. ConvertTo-Json prints one row as an object, not an array; malformed JSON is no rows. */
export function parseProcesses(stdout: string): ProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, '')); // 5.1 may write UTF-8's byte order mark before the JSON
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(rowOf);
}

// Started from pwsh 7, PSModulePath names 7's modules first and 5.1 fails to load them (as home-acl.ts found for Get-Acl): 5.1 uses its own
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
