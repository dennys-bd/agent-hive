import { chmod, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createInstaller, type Installer, type InstallerDeps } from '../src/editor-install.js';
import type { EditorInstallEvent } from '../src/types.js';
import { tempDir } from './temp-dir.js';

// The tools an install runs, as scripts in a temp folder (#780): no test depends on npm, go, tar, unzip or gunzip on the machine. An
// "archive" here is lines of <entry><TAB><content>; fake-extract writes the entries a stub tar or unzip is asked for.
const EXTRACT = `#!/bin/sh
archive="$1"; dest="$2"; shift 2
/usr/bin/awk -F '\\t' -v dest="$dest" -v want="$*" '
  BEGIN { n = split(want, list, " "); for (i = 1; i <= n; i++) keep[list[i]] = 1 }
  (n == 0 || ($1 in keep)) { file = dest "/" $1; dir = file; sub(/\\/[^\\/]*$/, "", dir); system("/bin/mkdir -p \\"" dir "\\""); print $2 > file; close(file); if ($1 ~ /bin\\//) system("/bin/chmod 755 \\"" file "\\"") }
' "$archive"
`;
export const STUBS: Record<string, string> = {
  node: '#!/bin/sh\nexit 0\n',
  npm: `#!/bin/sh
case "$*" in *--ignore-scripts*) ;; *) echo 'no --ignore-scripts' >&2; exit 9 ;; esac
dir="$3"; shift 6
for spec in "$@"; do name="\${spec%@latest}"; /bin/mkdir -p "$dir/node_modules/$name"; printf '{"version":"1.2.3"}' > "$dir/node_modules/$name/package.json"; done
`,
  go: '#!/bin/sh\n/bin/mkdir -p "$GOBIN"\nprintf \'#!/bin/sh\\n\' > "$GOBIN/gopls"\n/bin/chmod 755 "$GOBIN/gopls"\n',
  gunzip: `#!/bin/sh\n/bin/mv "$1" "\${1%.gz}"\n`,
  tar: '#!/bin/sh\n# tar -xzf FILE -C DEST\nexec "$(/usr/bin/dirname "$0")/fake-extract" "$2" "$4"\n',
  unzip: `#!/bin/sh
here="$(/usr/bin/dirname "$0")"; mode="$1"; archive="$2"; shift 2
case "$mode" in
  -Z1) exec /usr/bin/cut -f1 "$archive" ;;
  -p) exec /usr/bin/awk -F '\\t' -v n="$1" '$1 == n { print $2 }' "$archive" ;;
esac
names=""; dest=""
while [ $# -gt 0 ]; do if [ "$1" = "-d" ]; then dest="$2"; shift 2; else names="$names $1"; shift; fi; done
exec "$here/fake-extract" "$archive" "$dest" $names
`,
  'fake-extract': EXTRACT,
};

export async function writeStub(bin: string, name: string, body: string): Promise<void> {
  await writeFile(join(bin, name), body);
  await chmod(join(bin, name), 0o755);
}

/** An archive as the stubs read it. */
export const archive = (entries: Record<string, string>): string => `${Object.entries(entries).map(([name, content]) => `${name}\t${content}`).join('\n')}\n`;
export const json = (body: unknown) => (res: ServerResponse): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

export interface Rig { home: string; bin: string; base: string; events: EditorInstallEvent[]; installer: Installer; routes: Map<string, (res: ServerResponse) => void> }

/** An installer over a temp home, the stubs on its PATH (only the ones `tools` names), and a local server standing in for every registry. */
export async function rig(t: TestContext, tools: readonly string[] = Object.keys(STUBS), extra: Partial<InstallerDeps> = {}): Promise<Rig> {
  const home = await tempDir(t, 'editor-home-');
  const bin = await tempDir(t, 'editor-bin-');
  for (const name of tools) await writeStub(bin, name, STUBS[name]);
  const routes = new Map<string, (res: ServerResponse) => void>();
  const server = createServer((req, res) => { const route = routes.get(req.url ?? ''); if (route) route(res); else { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events: EditorInstallEvent[] = [];
  const installer = createInstaller({
    home, env: () => ({ PATH: bin }), arch: 'arm64', onState: (event) => events.push(event), downloads: { allowHttp: true }, ...extra,
    registries: { npm: `${base}/npm`, github: `${base}/gh`, goproxy: `${base}/go`, openvsx: `${base}/ovsx` },
  });
  return { home, bin, base, events, installer, routes };
}

// Fresh stub scripts can take seconds to start while the whole suite spawns processes, so the wait is generous; a passing run does not pay it
const SETTLE_TRIES = 3000;

/** Waits until `id`'s last event is no longer installing, and answers it. */
export async function settled(r: Rig, id: string): Promise<EditorInstallEvent> {
  for (let i = 0; i < SETTLE_TRIES; i += 1) {
    const last = r.events.filter((e) => e.id === id).at(-1);
    if (last !== undefined && last.state.state !== 'installing') return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${id} never settled`);
}
