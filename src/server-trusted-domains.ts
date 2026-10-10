import type { Express, Request, Response } from 'express';
import { isTrustedHost } from './trusted-hosts.js';
import type { Config, SettingsBody } from './types.js';

const HTTP_BAD_REQUEST = 400;
export const HOST_MESSAGE = 'host must be a host name (like github.com: no scheme, port, path or *)';

export interface TrustedDomainRouteDeps {
  requireLive(res: Response): { runtime: { config: Pick<Config, 'comb' | 'trustedDomains'> } } | undefined;
  /** Runs `save` on the POST /settings chain, after every save already queued: one writer of hive.config.json at a time. */
  queueSave(save: () => Promise<void>): Promise<void>;
  saveSettings(body: Partial<SettingsBody>, res: Response): Promise<void>;
}

/** POST /trusted-domains (#404): the terminal link dialog's "always trust". The host is checked with the parser's own rule, then the list
 * grows through saveSettings on the settings chain, so a trust never races a Settings save. The list is read on the chain, not at arrival: a save
 * queued first may have changed it. A host already there answers ok with no write. */
export function registerTrustedDomainRoutes(app: Express, { requireLive, queueSave, saveSettings }: TrustedDomainRouteDeps): void {
  app.post('/trusted-domains', (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const raw = (req.body ?? {}) as { host?: unknown };
    const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : '';
    if (!isTrustedHost(host)) return void res.status(HTTP_BAD_REQUEST).json({ error: HOST_MESSAGE });
    return queueSave(async () => {
      const live = requireLive(res);
      if (!live) return;
      const { comb, trustedDomains } = live.runtime.config;
      if (trustedDomains.includes(host)) return void res.json({ ok: true });
      await saveSettings({ prefix: comb.prefix, trustedDomains: [...trustedDomains, host] }, res); // configFrom keeps every other saved key
    });
  });
}
