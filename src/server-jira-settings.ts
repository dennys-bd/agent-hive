import type { Express, Request, Response } from 'express';
import { type JiraRouteDeps, normalizeJiraSite } from './server-jira.js';
import { answeredRateLimit, isNotConnected, type ReportRetry } from './source-errors.js';
import { jiraFetch } from './sources/jira-fetch.js';
import { storedKindOf } from './sources/jira-item.js';
import {
  type JiraCall, type JiraCreateField, type JiraFieldDef, PROJECT_KEY, readAssignable, readCreateFields, readFields, readIssueTypes, readLabels, readLinkTypes,
  readProjects, readStatuses,
} from './sources/jira-queries.js';
import type { FilterOptions } from './types.js';

// What the Settings form reads of a Jira source before it is saved (#821). Registered next to the connection routes, outside requireLive:
// the first Jira source is created in setup mode
const ROUTE = '/settings/jira';
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
// The source is not saved, so there is no source to put in backoff: the 429 goes out and nothing is reported
const NO_BACKOFF: ReportRetry = async () => {};

type Read = (call: JiraCall) => Promise<unknown>;
type ProjectRead = (call: JiraCall, project: string) => Promise<unknown>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// The transport is the only code that calls Jira; its default provider reads the site's stored login
const callFor = (site: string, { env, fetch }: JiraRouteDeps): JiraCall => (path, init) => jiraFetch(site, path, init, { env, fetch });

/** Not connected (no login, or a 401) is 409, so the form tells it from a Jira it could not reach; a rate limit is the 429 every source
 * route answers; anything else, a WireError included, is 502, never a 500. */
async function answerError(err: unknown, res: Response): Promise<void> {
  if (isNotConnected(err)) return void res.status(HTTP_CONFLICT).json({ error: 'not-connected' });
  if (await answeredRateLimit(err, 'jira', NO_BACKOFF, res)) return;
  res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
}

// jiraFetch's messages never carry the credential, so the raw one goes to hive.log with the site, and no body field does
async function answerRead(res: Response, site: string, deps: JiraRouteDeps, read: Read): Promise<void> {
  try {
    res.json(await read(callFor(site, deps)));
  } catch (err) {
    deps.log.warn(`jira settings ${site}: ${errorMessage(err)}`);
    await answerError(err, res);
  }
}

// Each a 400 naming its parameter before any call, the checks the parser and the connect route make: a bad value never reaches a URL
function siteOf(req: Request, res: Response): string | undefined {
  const site = normalizeJiraSite(req.query.site);
  if (site === undefined) res.status(HTTP_BAD_REQUEST).json({ error: 'invalid-site' });
  return site;
}
function projectOf(req: Request, res: Response): string | undefined {
  const { project } = req.query;
  if (typeof project === 'string' && PROJECT_KEY.test(project)) return project;
  res.status(HTTP_BAD_REQUEST).json({ error: 'invalid-project' });
  return undefined;
}

async function siteRoute(req: Request, res: Response, deps: JiraRouteDeps, read: Read): Promise<void> {
  const site = siteOf(req, res);
  if (site !== undefined) await answerRead(res, site, deps, read);
}
async function projectRoute(req: Request, res: Response, deps: JiraRouteDeps, read: ProjectRead): Promise<void> {
  const site = siteOf(req, res);
  if (site === undefined) return;
  const project = projectOf(req, res);
  if (project !== undefined) await answerRead(res, site, deps, (call) => read(call, project));
}

/** One GET per thing (#821): a site's projects and link types, a project's issue types. 6.3's GET /sources/:name/link-types reads the same reader. */
export function registerJiraSettingsRoutes(app: Express, deps: JiraRouteDeps): void {
  app.get(`${ROUTE}/projects`, (req: Request, res: Response) => siteRoute(req, res, deps, readProjects));
  app.get(`${ROUTE}/link-types`, (req: Request, res: Response) => siteRoute(req, res, deps, readLinkTypes));
  app.get(`${ROUTE}/issue-types`, (req: Request, res: Response) => projectRoute(req, res, deps, readIssueTypes));
}

/** GET /settings/source-columns?type=jira (#821): the project's status names in Jira's order, as the adapter's settingsOptions answers them.
 * readStatuses straight over the call: building a source would need a placeholder for every required key of the jira member. */
export const jiraColumns = (req: Request, res: Response, deps: JiraRouteDeps): Promise<void> =>
  projectRoute(req, res, deps, async (call, project) => (await readStatuses(call, project)).map((s) => s.name));

// A field the sync stores a value for, as one entry (#821). An option field offers the union, first seen first, of what every create
// screen of the project allows; a field on none offers [], and so does any other kind
function projectFieldOf(field: JiraFieldDef, screens: readonly JiraCreateField[]): FilterOptions['projectFields'] {
  const kind = storedKindOf(field);
  if (kind === undefined) return [];
  const options = kind === 'option' ? [...new Set(screens.filter((s) => s.name === field.name).flatMap((s) => s.allowedValues))] : [];
  return [{ name: field.name, options }];
}

// 1 + N calls after the first round (N = the project's issue types). The jira member refuses milestone and repository rules, so both are []
async function filterOptions(call: JiraCall, project: string): Promise<FilterOptions> {
  const [fields, assignable, labels, types] = await Promise.all([readFields(call), readAssignable(call, project), readLabels(call), readIssueTypes(call, project)]);
  const screens = (await Promise.all(types.map((type) => readCreateFields(call, project, type.id)))).flat();
  return { assignees: [...new Set(['@me', ...assignable])], labels, milestones: [], repositories: [], projectFields: fields.flatMap((f) => projectFieldOf(f, screens)) };
}

/** GET /settings/filter-options?type=jira (#821): the existing FilterOptions shape, read live, so it works before the first sync. */
export const jiraFilterOptions = (req: Request, res: Response, deps: JiraRouteDeps): Promise<void> => projectRoute(req, res, deps, filterOptions);
