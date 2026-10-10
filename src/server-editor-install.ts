// Settings › editor's installs (#780) and the syntax packages' files the page loads. Installs run in the background and report on the state
// stream; the files route serves only what a package extracted, by its real path.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { Express, Request, Response } from 'express';
import { editorDir, type Installer } from './editor-install.js';
import { isServerId, isSyntaxId } from './languages.js';
import { INSTALL_ACTIONS, type InstallAction, type InstallTarget, type ServerId } from './types.js';

export interface EditorInstallDeps { home: string; installer: Installer; stopServer(id: ServerId): Promise<void> }

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

function targetOf(kind: unknown, id: unknown): InstallTarget | undefined {
  if (typeof id !== 'string') return undefined;
  if (kind === 'server' && isServerId(id)) return { kind, id };
  if (kind === 'syntax' && isSyntaxId(id)) return { kind, id };
  return undefined;
}

// A package's file by its real path (symlinks followed), inside its extension/ folder; undefined otherwise
async function syntaxFile(home: string, id: string, rest: string[]): Promise<string | undefined> {
  if (!isSyntaxId(id)) return undefined;
  try {
    const root = await realpath(join(editorDir(home, { kind: 'syntax', id }), 'extension'));
    const file = await realpath(join(root, ...rest));
    return file.startsWith(`${root}${sep}`) && (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

async function act(req: Request, res: Response, deps: EditorInstallDeps): Promise<void> {
  const target = targetOf(req.params.kind, req.params.id);
  if (target === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: 'unknown install' });
  const { action } = (req.body ?? {}) as { action?: unknown };
  if (!INSTALL_ACTIONS.includes(action as InstallAction)) return void res.status(HTTP_BAD_REQUEST).json({ error: `action must be one of: ${INSTALL_ACTIONS.join(', ')}` });
  if (action === 'remove' && target.kind === 'server') await deps.stopServer(target.id); // no process runs from a folder that is going
  const outcome = await deps.installer.act(target, action as InstallAction);
  res.status(outcome.status).json('state' in outcome ? outcome.state : { error: outcome.message });
}

/** GET and POST /settings/editor/installs and GET /editor/syntax/:id/*file (#780). Whatever the disk throws answers 500. */
export function registerEditorInstallRoutes(app: Express, deps: EditorInstallDeps): void {
  const guarded = (handle: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
    try { await handle(req, res); } catch (err) { res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) }); }
  };
  app.get('/settings/editor/installs', guarded(async (_req, res) => { res.json(await deps.installer.installs()); }));
  app.post('/settings/editor/installs/:kind/:id', guarded((req, res) => act(req, res, deps)));
  app.get('/editor/syntax/:id/*file', guarded(async (req, res) => {
    const raw: unknown = (req.params as Record<string, unknown>).file; // Express 5's named wildcard: the segments, decoded
    const rest = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split('/');
    const file = await syntaxFile(deps.home, String(req.params.id), rest);
    if (file === undefined) return void res.status(HTTP_NOT_FOUND).json({ error: 'no such file' });
    res.type(extname(file) === '.json' ? 'application/json' : 'text/plain').send(await readFile(file, 'utf8'));
  }));
}
