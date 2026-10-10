import { spawnSync } from 'node:child_process';

// pgrep exits 1 when nothing matches and 3 when it cannot read the process table, as inside Claude Code's macOS sandbox (#105), where a
// worker runs this suite: a test that needs the real process list is skipped there with the reason, and runs everywhere else.
const probe = spawnSync('pgrep', ['-x', 'hive-no-such-process'], { encoding: 'utf8' });
const refused = probe.error !== undefined || (probe.status !== 0 && probe.status !== 1);

/** Why the real process list cannot be read here, or false when it can: the `skip` option of a test that greps or kills by pattern. */
export const NO_PROCESS_LIST: string | false = refused ? `the process list is not readable here (pgrep: ${(probe.stderr ?? '').trim() || probe.error?.message})` : false;
