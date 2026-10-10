import { getJson } from './api.js'; // relative: the root tsc compiles this file too, and it has no @/ alias

/** How many agents run uncaptured in a terminal (#696): GET /terminals/:id/agents; 0 when the route fails, so a failed read never blocks a
 * sleep the user asked for. */
export async function strayAgents(terminalId: string): Promise<number> {
  try {
    const { agents } = await getJson<{ agents?: unknown }>(`/terminals/${encodeURIComponent(terminalId)}/agents`);
    return Array.isArray(agents) ? agents.length : 0;
  } catch {
    return 0;
  }
}
