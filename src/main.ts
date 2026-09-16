import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { bootHive } from './hive.js';

const WINDOW = { width: 1280, height: 820, backgroundColor: '#111418' };

function lastRepoFile(): string {
  return join(app.getPath('userData'), 'last-repo');
}

async function rememberRepo(repo: string): Promise<void> {
  await mkdir(dirname(lastRepoFile()), { recursive: true });
  await writeFile(lastRepoFile(), repo);
}

async function pickRepo(): Promise<string | undefined> {
  const fromArgv = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  if (fromArgv) return resolve(fromArgv);
  const remembered = await readFile(lastRepoFile(), 'utf8').catch(() => '');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Escolha o repositório com hive.config.json',
    defaultPath: remembered || undefined,
    properties: ['openDirectory'],
  });
  return canceled ? undefined : filePaths[0];
}

function openWindow(port: number): void {
  const origin = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow(WINDOW);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((err: Error) => console.error('openExternal failed:', err.message));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    shell.openExternal(url).catch((err: Error) => console.error('openExternal failed:', err.message));
  });
  win.loadURL(`${origin}/`).catch((err: Error) => dialog.showErrorBox('Agent Hive', err.message));
}

app.whenReady().then(async () => {
  const repo = await pickRepo();
  if (!repo) {
    app.quit();
    return;
  }
  await rememberRepo(repo);
  const { port } = await bootHive(repo);
  openWindow(port);
}).catch((err: Error) => {
  dialog.showErrorBox('Agent Hive', err.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
