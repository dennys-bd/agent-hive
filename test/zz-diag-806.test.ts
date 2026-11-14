// TEMPORARY (#806): prints what Git's sh.exe sees for the shim's lookup on the Windows lane. Removed once read.
import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { posixShell } from '../src/posix-shell.js';
import { searchPath, setup } from './command-shim-rig.js';

const PROBE = `
echo "mount: $(mount | head -3 | tr '\\n' '|')"
echo "PATH: $PATH"
echo "PATHEXT: $PATHEXT"
for d in "$SHIMS" "$VBS" "$CMDS" "$REAL"; do
  if [ "$d" -ef "$SHIMS" ]; then e=yes; else e=no; fi
  echo "dir $d ef-shims=$e ino=$(ls -id "$d" 2>&1)"
done
for f in "$CMDS/pnpm.bat" "$CMDS/pnpm.cmd" "$VBS/pnpm.vbs" "$REAL/pnpm" "$SHIMS/pnpm"; do
  t=; [ -f "$f" ] && t="$t f"; [ -x "$f" ] && t="$t x"; [ "$f" -ef "$SHIM" ] && t="$t ef-shim"
  echo "file $f:$t ls=$(ls -li "$f" 2>&1)"
done
for f in "$CMDS/pnpm.cmd" "$CMDS/pnpm.bat"; do
  out=$("$f" a b 2>&1); echo "exec $f: code=$? out=$out"
done
`;

test('diag #806: what sh.exe sees', { skip: process.platform !== 'win32' && 'diag runs on the Windows lane only' }, async (t) => {
  const { r } = await setup(t, 'run', 'pnpm', 'win32');
  const vbs = join(r.root, 'vbs');
  const cmds = join(r.root, 'cmds');
  for (const [dir, name] of [[vbs, 'pnpm.vbs'], [cmds, 'pnpm.bat'], [cmds, 'pnpm.cmd']] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), '@echo ran\r\n');
    await chmod(join(dir, name), 0o755);
  }
  const probe = join(r.root, 'probe.sh');
  await writeFile(probe, PROBE);
  const env = { ...r.env, PATH: searchPath(join(r.root, 'command-shims'), vbs, cmds, join(r.root, 'real')), SHIMS: join(r.root, 'command-shims'), VBS: vbs, CMDS: cmds, REAL: join(r.root, 'real'), SHIM: r.shim };
  const { stdout, stderr } = await promisify(execFile)(posixShell().shell, [probe], { env });
  console.log(`DIAG806 stdout:\n${stdout}\nDIAG806 stderr:\n${stderr}`);
});
