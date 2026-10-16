// The new session dialog's lists (#257), GET /launch-options, and the checks of a free session's picks: the open routes' checkLaunch and the
// spawn's launchRun, out of server-open.ts and server-spawn.ts.
import type { Express, Request, Response } from 'express';
import { AGENTS } from './agents.js';
import type { AgentRun } from './agents/runner.js';
import { CLAUDE_ALIASES, CLAUDE_VERSIONS } from './agents/claude-models.js';
import { agentRoles, CODEX_PLUGIN } from './agents/codex-home.js';
import { CLAUDE_MODEL } from './config-agent-args.js';
import { pluginSource } from './hooks-settings.js';
import { isLaunchArgs, isLaunchModel, savedLaunch } from './launch-pick.js';
import type { Logger } from './log.js';
import { isRecord } from './rate-limits.js';
import type { Refusal, TaskRouteDeps } from './server-tasks.js';
import type { AgentId, Exec, Language, LaunchOption, LaunchOptions, LaunchPick } from './types.js';
import { MESSAGES } from './ui/i18n.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const CODEX_MODELS_TIMEOUT_MS = 10_000; // a hung CLI never holds the dialog's lists: Codex's stay empty

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// An agent file the plugin cannot read (agentRoles throws on a bad frontmatter): its reason in words, never a stack
const pluginMessage = (err: unknown, language: Language): string => `${MESSAGES[language]['launch.pluginUnreadable']} ${errorMessage(err)}`;

/** One of the Hive plugin's agents as a session runs it (#257): hive:<name>, its description, and the body Codex gets as instructions. */
export interface SpecializedAgent { name: string; description: string; instructions: string }

/** The Hive plugin's agents, sorted by file as agentRoles reads them. Throws on an agent file with a bad frontmatter. */
export const specializedAgents = (source: string = pluginSource()): SpecializedAgent[] =>
  agentRoles(source).map((role) => ({ name: `${CODEX_PLUGIN}:${role.name}`, description: role.description, instructions: role.instructions }));

// One entry of `codex debug models`, narrowed from unknown: a slug the routes would admit as a model, its display name as the hint when it adds one
function codexModel(value: unknown): { option: LaunchOption; isHidden: boolean }[] {
  if (!isRecord(value)) return [];
  const { slug, display_name: name, visibility } = value;
  if (!isLaunchModel(slug)) return [];
  const hint = typeof name === 'string' && name !== '' && name !== slug ? { hint: name } : {};
  return [{ option: { id: slug, ...hint }, isHidden: visibility === 'hide' }];
}

/** Codex's models as `codex debug models` prints them (#257): visible first, hidden after, each group in the CLI's order. Throws on bad JSON. */
export function parseCodexModels(stdout: string): LaunchOption[] {
  const parsed: unknown = JSON.parse(stdout);
  const list: unknown[] = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  const models = list.flatMap(codexModel);
  return [...models.filter((m) => !m.isHidden), ...models.filter((m) => m.isHidden)].map((m) => m.option);
}

// Codex's list, or none: a missing CLI, a failure or output that is not JSON leaves the field to typed names
async function codexModels(exec: Exec, log: Pick<Logger, 'info'>): Promise<LaunchOption[]> {
  try {
    return parseCodexModels((await exec(AGENTS.codex.command, ['debug', 'models'], { timeout: CODEX_MODELS_TIMEOUT_MS })).stdout);
  } catch (err) {
    log.info(`launch options: codex debug models gave no list: ${errorMessage(err).split('\n')[0]}`);
    return [];
  }
}

/** GET /launch-options' answer (#257): Claude's hand-kept models, Codex's from its CLI, the plugin's agents for both, each agent's config args.
 * Throws when the plugin's agents cannot be read. */
export async function launchOptions(exec: Exec, log: Pick<Logger, 'info'>, agentArgs: Record<AgentId, string[]>): Promise<LaunchOptions> {
  const agents = specializedAgents().map(({ name, description }) => ({ name, description }));
  const codex = await codexModels(exec, log);
  return {
    claude: { aliases: [...CLAUDE_ALIASES], versions: [...CLAUDE_VERSIONS], specializedAgents: agents, args: [...agentArgs.claude] },
    codex: { aliases: [], versions: codex, specializedAgents: agents, args: [...agentArgs.codex] },
  };
}

/** GET /launch-options (#257). A plugin agent file that cannot be read answers 500 with its reason. */
export function registerLaunchOptionsRoute(app: Express, deps: Pick<TaskRouteDeps, 'requireLive' | 'exec' | 'log' | 'language'>): void {
  app.get('/launch-options', async (_req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    try {
      res.json(await launchOptions(deps.exec, deps.log, current.runtime.config.agentArgs));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: pluginMessage(err, deps.language()) });
    }
  });
}

type LaunchRefusal = 'terminal' | 'continue' | 'model' | 'codexModel' | 'specializedAgent' | 'args';
const refusal = (key: LaunchRefusal, language: Language): Refusal => ({ status: HTTP_BAD_REQUEST, message: MESSAGES[language][`launch.refused.${key}`] });

/** A request's picks (#257), as the open routes take them: none is the defaults ({}); any on a terminal (`agent` undefined) or a resume, or
 * one out of shape, is a 400 naming the field. A Claude model on a Codex session is refused as a codex stage's is (#927). `roles` holds the
 * plugin's hive:<name> agents. */
export function checkLaunch(body: unknown, agent: AgentId | undefined, roles: readonly string[], language: Language): { launch?: LaunchPick } | Refusal {
  const { model, specializedAgent, args, continueId } = (isRecord(body) ? body : {}) as Record<string, unknown>;
  if (model === undefined && specializedAgent === undefined && args === undefined) return {};
  if (agent === undefined) return refusal('terminal', language);
  if (continueId !== undefined) return refusal('continue', language);
  if (model !== undefined && !isLaunchModel(model)) return refusal('model', language);
  if (agent === 'codex' && isLaunchModel(model) && CLAUDE_MODEL.test(model)) return refusal('codexModel', language);
  if (specializedAgent !== undefined && !(typeof specializedAgent === 'string' && roles.includes(specializedAgent))) return refusal('specializedAgent', language);
  if (args !== undefined && !isLaunchArgs(args)) return refusal('args', language);
  const launch: LaunchPick = {
    ...(isLaunchModel(model) ? { model } : {}),
    ...(typeof specializedAgent === 'string' ? { specializedAgent } : {}),
    ...(isLaunchArgs(args) && args.length > 0 ? { args } : {}),
  };
  return Object.keys(launch).length === 0 ? {} : { launch };
}

/** checkLaunch at an open route (#257): the plugin's agents are read only when the request names one; a plugin it cannot read is a 500 with
 * the reason. */
export function askedLaunch(body: unknown, agent: AgentId | undefined, language: Language): { launch?: LaunchPick } | Refusal {
  const isNamed = isRecord(body) && body.specializedAgent !== undefined;
  try {
    return checkLaunch(body, agent, isNamed ? specializedAgents().map((a) => a.name) : [], language);
  } catch (err) {
    return { status: HTTP_SERVER_ERROR, message: pluginMessage(err, language) };
  }
}

/** What a free session's picks add to its run (#257): the model, the config's args then its own, and its specialized agent with the body
 * Codex gets as instructions; or why it cannot start: an agent the plugin no longer has, or a plugin it cannot read. The picks are checked
 * again (savedLaunch): a worker loaded from a hand-edited state.json never puts an option where a value goes. `roles` are the run's plugin
 * folder's agents (#316). */
export function launchRun(launch: LaunchPick | undefined, configArgs: readonly string[], roles: () => readonly SpecializedAgent[]): Pick<AgentRun, 'model' | 'extraArgs' | 'specializedAgent'> | { refusal: string } {
  const kept = savedLaunch(launch).launch;
  const base = { ...(kept?.model === undefined ? {} : { model: kept.model }), extraArgs: [...configArgs, ...(kept?.args ?? [])] };
  const name = kept?.specializedAgent;
  if (name === undefined) return base;
  let found: SpecializedAgent | undefined;
  try {
    found = roles().find((a) => a.name === name);
  } catch (err) {
    return { refusal: `the Hive plugin's agents could not be read: ${errorMessage(err)}` };
  }
  return found === undefined
    ? { refusal: `specialized agent ${name} is no longer in the Hive plugin` }
    : { ...base, specializedAgent: { name: found.name, instructions: found.instructions } };
}
