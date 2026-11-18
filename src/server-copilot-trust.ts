import type { Express, Request, Response } from 'express';
import { copilotHomeOf } from './agents/copilot-home.js';
import { uncoveredFolders } from './agents/copilot-trust.js';
import type { MachineInfo } from './machine.js';

// GET /settings/copilot-trust (#880): the saved workspaces' folders no trustedFolders entry of Copilot's config.json covers, read each time
// Settings opens. Unknown answers [] as covered does: the UI shows nothing for either. Read-only, as /settings/nested-repos.

const HTTP_SERVER_ERROR = 500;

export interface CopilotTrustRouteDeps {
  workspacePaths(): readonly string[]; // the saved config's, in its order; [] in setup mode
  info(): Pick<MachineInfo, 'homedir' | 'copilotHome' | 'platform'>; // the local machine's, whose COPILOT_HOME the workers inherit
}

export function registerCopilotTrustRoute(app: Express, deps: CopilotTrustRouteDeps): void {
  app.get('/settings/copilot-trust', async (_req: Request, res: Response) => {
    try {
      const info = deps.info();
      const uncovered = await uncoveredFolders(copilotHomeOf(info), deps.workspacePaths(), info.platform);
      res.json({ uncovered: uncovered ?? [] });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
