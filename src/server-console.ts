import type { Express, Request, Response } from 'express';
import type { ConsoleStore } from './console.js';
import type { TaskRouteDeps } from './server-tasks.js';

const HTTP_NOT_FOUND = 404;
const UNKNOWN_CHANNEL_MESSAGE = 'canal desconhecido';

type ConsoleRouteDeps = Pick<TaskRouteDeps, 'requireLive'> & { consoleStore: Pick<ConsoleStore, 'channels' | 'history' | 'clear'> };

/** The console's two reads (#353): the channels, and one channel's finished runs as text plus its live runs, which the page then reads over
 * the pty socket (#407); and the drawer's limpar (#537), which drops a channel's finished runs. Runs begin and end in the spawner. An unknown
 * channel (a daemon restart emptied it) is a 404, and the page drops it. */
export function registerConsoleRoutes(app: Express, { requireLive, consoleStore }: ConsoleRouteDeps): void {
  app.get('/console', (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    res.json(consoleStore.channels());
  });
  app.get('/console/:id', (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const { run } = req.query; // a commands stage's tab: only that execution's runs (#755)
    const view = consoleStore.history(req.params.id as string, typeof run === 'string' && run !== '' ? run : undefined);
    if (!view) return void res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_CHANNEL_MESSAGE });
    res.json(view);
  });
  app.post('/console/:id/clear', (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    if (!consoleStore.clear(req.params.id as string)) return void res.status(HTTP_NOT_FOUND).json({ error: UNKNOWN_CHANNEL_MESSAGE });
    res.json({ ok: true });
  });
}
