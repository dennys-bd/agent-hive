// The PR poll after every source poll (#207), split by host (#1052): GitHub's open PRs in the one gh query as before, GitLab's MRs through
// each host's account, so no GitLab link is ever in a GitHub query. Neither read waits on the other's outcome, and each dispatches its own
// prStates. Out of server.ts, which is past 400 lines.
import { type GitlabAccess, readMrActivity, readMrStates } from './gitlab/pr-states.js';
import type { Logger } from './log.js';
import { openPrUrls, type PrActivity, parsePrStates, prStatesQuery } from './pull-requests.js';
import { GITHUB_HOST, parsePrLink } from './repo-host.js';
import type { ServerFacts } from './server-facts.js';
import type { Effect, Gql, HiveEvent, State } from './types.js';

export interface PrPollDeps {
  state(): State | undefined;
  gql: Gql; // gh api graphql, the GitHub PRs' query
  gitlab: GitlabAccess; // a host's client from its stored account, read at every poll, so a connect needs no restart
  dispatch(event: HiveEvent): Promise<Effect[]>;
  log: Pick<Logger, 'error'>;
  pollPrActivity: ServerFacts['pollPrActivity'];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// One query for every open GitHub PR, one point at most; a failure is logged and every PR keeps its last known state
async function readGithub(deps: PrPollDeps, urls: string[]): Promise<void> {
  const query = prStatesQuery(urls);
  if (query === undefined) return;
  try {
    const states = parsePrStates(urls, await deps.gql(query));
    if (states.length > 0) await deps.dispatch({ type: 'prStates', states });
  } catch (err) {
    deps.log.error(`pr states: ${errorMessage(err)}`);
  }
}

// Each open MR's state, then its commits apart, so a failed commits read costs no state. Answers the commits for the fact log
async function readGitlab(deps: PrPollDeps, urls: string[]): Promise<PrActivity[]> {
  if (urls.length === 0) return [];
  try {
    const states = await readMrStates(urls, deps.gitlab);
    for (const line of states.failures) deps.log.error(`pr states gitlab ${line}`);
    if (states.reads.length > 0) await deps.dispatch({ type: 'prStates', states: states.reads });
    const activity = await readMrActivity(states.reads, deps.gitlab);
    for (const line of activity.failures) deps.log.error(`pr activity gitlab ${line}`);
    return activity.reads;
  } catch (err) {
    deps.log.error(`pr states gitlab: ${errorMessage(err)}`); // the store unreadable: every MR keeps its state
    return [];
  }
}

/** Every open PR's state and times, GitHub's and GitLab's apart (#207, #742, #1052), then the activity of both in one fact-log write. */
export async function pollPrStates(deps: PrPollDeps): Promise<void> {
  const urls = openPrUrls(deps.state()?.activityRecords ?? []);
  const github = urls.filter((url) => parsePrLink(url)?.host === GITHUB_HOST);
  const gitlab = urls.filter((url) => !github.includes(url));
  const [, mrs] = await Promise.all([readGithub(deps, github), readGitlab(deps, gitlab)]);
  await deps.pollPrActivity(deps.state(), github, deps.gql, mrs, urls);
}
