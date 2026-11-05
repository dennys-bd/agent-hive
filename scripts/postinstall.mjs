// pnpm's postinstall (#624): node-pty ships its darwin spawn-helper without the execute bit, and a pty cannot spawn without it.
// Plain node, not a shell `chmod`, so the same line runs under cmd, PowerShell and sh.
import { chmodSync, globSync } from 'node:fs';
import { join } from 'node:path';

const HELPERS = 'node_modules/node-pty/prebuilds/darwin-*/spawn-helper';

export function makeSpawnHelperExecutable(platform, root) {
  if (platform !== 'darwin') return;
  const helpers = globSync(HELPERS, { cwd: root });
  // failing here, as the old `chmod` on an unmatched glob did, beats a pty that cannot spawn at run time
  if (helpers.length === 0) throw new Error(`postinstall: no node-pty spawn-helper matches ${HELPERS}`);
  for (const helper of helpers) chmodSync(join(root, helper), 0o755);
}

if (import.meta.main) makeSpawnHelperExecutable(process.platform, process.cwd());
