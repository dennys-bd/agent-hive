import { listed, listingText } from './process-table.js';

const FIRST_PID = 4242;
// win32 has no pkill (#638): killStray lists Win32_Process through PowerShell and taskkills each row whose line matches
export const isListing = (args: readonly string[]): boolean => args.includes('-EncodedCommand');
/** The listing's stdout: one row per command line, pids from FIRST_PID up, as win-procs.ts's script prints them. */
export const listing = (lines: readonly string[]): string => listingText(lines.map((line, i) => listed(FIRST_PID + i, 1, line)));
/** The call that kills the process whose line is the index-th of `listing`, on this platform. */
export const strayKill = (pattern: string, index = 0): string[] =>
  (process.platform === 'win32' ? ['taskkill', '/T', '/F', '/PID', String(FIRST_PID + index)] : ['pkill', '-f', '--', pattern]);
