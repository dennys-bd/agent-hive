// The MCP routes (#333): the tool switches and the external servers change through saveSettings on the settings chain, as POST /trusted-domains does;
// a header value lives in credentials.json, which no answer ever carries (GET says hasValue, never the value).
import type { Express, Request, Response } from 'express';
import { runServer, parseMcp } from './mcp-settings.js';
import type { Probe } from './mcp-probe.js';
import { type Config, type Credentials, type ExternalMcpServer, LOCKED_TOOLS, type McpServerState, type McpSettings, OPTIONAL_TOOLS, type OptionalTool, type SettingsBody } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const VALUE_MAX = 4096;
const UNKNOWN_SERVER = 'unknown server';
export const lockedMessage = (name: string): string => `${name} is locked: the Hive needs it`;
export const VALUE_MESSAGE = `value must be 1 to ${VALUE_MAX} characters, without a line break`;

type Live = { runtime: { config: Pick<Config, 'comb' | 'mcp'> } };
export interface McpRouteDeps {
  requireLive(res: Response): Live | undefined;
  /** Runs `save` on the POST /settings chain, after every save already queued. */
  queueSave(save: () => Promise<void>): Promise<void>;
  saveSettings(body: Partial<SettingsBody>, res: Response, afterSave?: () => Promise<void>): Promise<void>;
  credentials: { read(): Promise<Credentials>; write(next: Credentials): Promise<void> };
  probe: Probe; // cachedProbe's
}

const hasStored = (credentials: Credentials, name: string): boolean => credentials.mcp !== undefined && Object.hasOwn(credentials.mcp, name);

// Credentials are never mutated: both return a new object
function dropValue(credentials: Credentials, name: string): Credentials {
  if (!hasStored(credentials, name)) return credentials;
  return { ...credentials, mcp: Object.fromEntries(Object.entries(credentials.mcp ?? {}).filter(([key]) => key !== name)) };
}

function moveValue(credentials: Credentials, from: string, to: string): Credentials {
  const entry = credentials.mcp?.[from];
  if (from === to || !entry || !hasStored(credentials, from)) return credentials;
  const rest = dropValue(credentials, from);
  return { ...rest, mcp: { ...rest.mcp, [to]: entry } };
}

const fail = (res: Response, status: number, error: string): void => void res.status(status).json({ error });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function registerRead(app: Express, { requireLive, credentials, probe }: McpRouteDeps): void {
  app.get('/api/mcp', async (_req: Request, res: Response) => {
    const live = requireLive(res);
    if (!live) return;
    const { off, servers } = live.runtime.config.mcp;
    const stored = await credentials.read();
    const state = async (server: ExternalMcpServer): Promise<McpServerState> => (server.on ? probe(runServer(server, stored)) : 'off');
    const answered = await Promise.all(servers.map(async (server) => ({ ...server, hasValue: hasStored(stored, server.name), state: await state(server) })));
    res.json({
      tools: [...LOCKED_TOOLS.map((name) => ({ name, locked: true, on: true })), ...OPTIONAL_TOOLS.map((name) => ({ name, locked: false, on: !off.includes(name) }))],
      servers: answered,
    });
  });
}

// One helper for every config change: read the live key on the chain, parse the change, then save through the settings chain
// `change` answers undefined when the server a route names is not there
function changer({ requireLive, queueSave, saveSettings }: McpRouteDeps) {
  return (res: Response, change: (mcp: McpSettings) => unknown, afterSave?: (parsed: McpSettings) => Promise<void>): Promise<void> =>
    queueSave(async () => {
      const live = requireLive(res);
      if (!live) return;
      const { comb, mcp } = live.runtime.config;
      const changed = change(mcp);
      if (changed === undefined) return fail(res, HTTP_NOT_FOUND, UNKNOWN_SERVER); // only a server route has an unknown name
      const parsed = parseMcp(changed, comb.workspaces.map((w) => w.name));
      if (typeof parsed === 'string') return fail(res, HTTP_BAD_REQUEST, parsed);
      await saveSettings({ prefix: comb.prefix, mcp: parsed }, res, afterSave && (() => afterSave(parsed)));
    });
}
type Change = ReturnType<typeof changer>;

function registerTools(app: Express, deps: McpRouteDeps, change: Change): void {
  app.put('/api/mcp/tools/:name', (req: Request<{ name: string }>, res: Response) => {
    if (!deps.requireLive(res)) return;
    const { name } = req.params;
    if ((LOCKED_TOOLS as readonly string[]).includes(name)) return fail(res, HTTP_BAD_REQUEST, lockedMessage(name));
    if (!(OPTIONAL_TOOLS as readonly string[]).includes(name)) return fail(res, HTTP_NOT_FOUND, 'unknown tool');
    const { on } = (req.body ?? {}) as { on?: unknown };
    if (typeof on !== 'boolean') return fail(res, HTTP_BAD_REQUEST, 'on must be true or false');
    const tool = name as OptionalTool;
    return change(res, (mcp) => ({ ...mcp, off: on ? mcp.off.filter((n) => n !== tool) : [...mcp.off.filter((n) => n !== tool), tool] }));
  });
}

function registerServers(app: Express, deps: McpRouteDeps, change: Change): void {
  const { requireLive, credentials } = deps;
  const body = (req: Request): unknown => req.body ?? {};
  // Written only when the change did something
  const update = async (edit: (c: Credentials) => Credentials): Promise<void> => {
    const stored = await credentials.read();
    const next = edit(stored);
    if (next !== stored) await credentials.write(next);
  };
  app.post('/api/mcp/servers', (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    // A value stored under the name by a server since removed (or by hand) is no business of the new one
    return change(res, (mcp) => ({ ...mcp, servers: [...mcp.servers, body(req)] }), async (parsed) => update((c) => dropValue(c, parsed.servers[parsed.servers.length - 1].name)));
  });
  app.put('/api/mcp/servers/:name', (req: Request<{ name: string }>, res: Response) => {
    if (!requireLive(res)) return;
    const { name } = req.params;
    let index = -1;
    let before: ExternalMcpServer | undefined;
    const replaced = (mcp: McpSettings): unknown => {
      index = mcp.servers.findIndex((s) => s.name === name);
      before = mcp.servers[index];
      return index < 0 ? undefined : { ...mcp, servers: mcp.servers.map((s, i) => (i === index ? body(req) : s)) };
    };
    return change(res, replaced, async (parsed) => {
      const after = parsed.servers[index]; // parseMcp kept the list's length and order
      // The value is a credential for one endpoint and header: it never follows a server to another
      const sameTarget = before !== undefined && 'url' in before && 'url' in after && before.url === after.url && before.authHeader === after.authHeader;
      await update(sameTarget ? (c) => moveValue(c, name, after.name) : (c) => dropValue(dropValue(c, name), after.name));
    });
  });
  app.delete('/api/mcp/servers/:name', (req: Request<{ name: string }>, res: Response) => {
    if (!requireLive(res)) return;
    const { name } = req.params;
    const removed = (mcp: McpSettings): unknown => (mcp.servers.some((s) => s.name === name) ? { ...mcp, servers: mcp.servers.filter((s) => s.name !== name) } : undefined);
    return change(res, removed, async () => credentials.write(dropValue(await credentials.read(), name)));
  });
}

const validValue = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= VALUE_MAX && !/[\r\n]/.test(value);

function registerValues(app: Express, { requireLive, queueSave, credentials }: McpRouteDeps): void {
  app.put('/api/mcp/servers/:name/value', (req: Request<{ name: string }>, res: Response) => {
    if (!requireLive(res)) return;
    const { value } = (req.body ?? {}) as { value?: unknown };
    if (!validValue(value)) return fail(res, HTTP_BAD_REQUEST, VALUE_MESSAGE);
    const { name } = req.params;
    return queueSave(async () => {
      const server = requireLive(res)?.runtime.config.mcp.servers.find((s) => s.name === name);
      if (!server) return fail(res, HTTP_NOT_FOUND, UNKNOWN_SERVER);
      if (!('url' in server) || server.authHeader === undefined) return fail(res, HTTP_BAD_REQUEST, `${name} takes no header value: only a url server with authHeader has one`);
      try {
        const stored = await credentials.read();
        await credentials.write({ ...stored, mcp: { ...stored.mcp, [name]: { value } } });
      } catch (err) {
        return fail(res, HTTP_SERVER_ERROR, message(err));
      }
      res.json({ ok: true });
    });
  });
  app.delete('/api/mcp/servers/:name/value', (req: Request<{ name: string }>, res: Response) => {
    if (!requireLive(res)) return;
    return queueSave(async () => {
      if (!requireLive(res)?.runtime.config.mcp.servers.some((s) => s.name === req.params.name)) return fail(res, HTTP_NOT_FOUND, UNKNOWN_SERVER);
      try {
        await credentials.write(dropValue(await credentials.read(), req.params.name));
      } catch (err) {
        return fail(res, HTTP_SERVER_ERROR, message(err));
      }
      res.json({ ok: true });
    });
  });
}

export function registerMcpRoutes(app: Express, deps: McpRouteDeps): void {
  const change = changer(deps);
  registerRead(app, deps);
  registerTools(app, deps, change);
  registerServers(app, deps, change);
  registerValues(app, deps);
}
