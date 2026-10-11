import { stripVTControlCharacters } from 'node:util';
import { awaitingOf, canPushOf, checkOf, headRollup, isObject, nodesOf, readable, rollupFields, SUITE_FIELDS } from './pr-checks.js';
import { type Alias, aliasedQuery, aliasOf } from './pull-requests.js';
import type { CiCheck, CiChecks, CiPrRead, Stage, StageCiCheck } from './types.js';

// A PR's CI for a wait-for-CI stage (#834), on top of #758's checks (pr-checks.ts): the same rollup and the same states, plus what the stage
// needs (the head commit, the Actions run behind each check run, the base branch's required checks) and the verdict. Pure.

/** Per PR: its base branch's required checks, the login's permission on its repository (#854), the default branch's workflows folder (#11) and
 * #758's rollup, with the head's oid, its check suites (#854) and each check run's workflow run. */
export const CI_FIELDS = 'baseRef { refUpdateRule { requiredStatusCheckContexts } } '
  + 'repository { viewerPermission workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } } } '
  + rollupFields(`oid ${SUITE_FIELDS} `, ' checkSuite { workflowRun { databaseId } }');


// GitHub's text reaches the output and the card: ANSI and every control character but the tab and the line break go, and a check's name
// keeps no line break either, so it cannot forge a header line
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const cleanText = (text: string): string => stripVTControlCharacters(text).replace(CONTROL, '');
export const cleanName = (name: string): string => cleanText(name.replace(/[\r\n]/g, ' '));

/** One aliased query for every link; none for no link. */
export const ciQuery = (urls: string[]): string | undefined => aliasedQuery(urls, CI_FIELDS);

// The Actions run behind a check run; none for a status context or a check run from outside Actions
function runIdOf(node: unknown): { runId?: number } {
  const suite = isObject(node) && isObject(node.checkSuite) ? node.checkSuite : undefined;
  const run = suite !== undefined && isObject(suite.workflowRun) ? suite.workflowRun : undefined;
  return typeof run?.databaseId === 'number' ? { runId: run.databaseId } : {};
}

// The head commit's sha: what a re-run is counted against
function headOf(alias: Alias): string | undefined {
  const [node] = nodesOf(alias.headCommit);
  const oid = isObject(node) && isObject(node.commit) ? node.commit.oid : undefined;
  return typeof oid === 'string' ? oid : undefined;
}

// The base branch's required check names, branch protection and rulesets alike; absent when the branch protects none
function requiredOf(alias: Alias): { required?: string[] } {
  const rule = isObject(alias.baseRef) && isObject(alias.baseRef.refUpdateRule) ? alias.baseRef.refUpdateRule : undefined;
  const names = rule?.requiredStatusCheckContexts;
  return Array.isArray(names) ? { required: names.filter((n): n is string => typeof n === 'string') } : {};
}

// #11: a repository with no workflow file on its default branch runs no Actions, so a PR there with no checks holds nothing. Only a read answer
// marks it: no repository or no workflows field keeps the wait. Known ceiling: a PR adding the repository's first workflow is not waited on
function noCiOf(repository: unknown): { noCi?: true } {
  if (!isObject(repository) || !('workflows' in repository)) return {};
  const { workflows } = repository;
  if (workflows === null) return { noCi: true };
  const names = isObject(workflows) && Array.isArray(workflows.entries) ? workflows.entries.map((e) => (isObject(e) ? e.name : undefined)) : undefined;
  return names !== undefined && !names.some((n) => typeof n === 'string' && /\.ya?ml$/i.test(n)) ? { noCi: true } : {};
}

/** Each PR's last commit and checks, alias p<i> for urls[i], each check as #758 reads it. A null or missing alias, one with no commit, and one
 * with a check checkOf cannot read have no entry: a skipped check could be the failed one, so the wait never reads it as passed. */
export function parseCi(urls: string[], data: unknown): CiPrRead[] {
  return urls.flatMap((url, i) => {
    const alias = aliasOf(data, i);
    const head = alias === undefined ? undefined : headOf(alias);
    if (alias === undefined || head === undefined) return [];
    let skipped = false;
    const read = (node: unknown): CiCheck => ({ ...checkOf(node), pr: url, ...runIdOf(node) });
    const checks = readable(nodesOf(headRollup(alias.headCommit)?.contexts), read, () => { skipped = true; });
    const permission = isObject(alias.repository) ? alias.repository.viewerPermission : undefined;
    const pr: CiPrRead = { url, head, ...requiredOf(alias), checks, awaiting: awaitingOf(alias.headCommit), canPush: canPushOf(permission), ...noCiOf(alias.repository) };
    return skipped ? [] : [pr];
  });
}

/** A check's name against a stage's pattern: `*` is any run of characters, the rest literal, the whole name, case-insensitive. */
export function matches(name: string, pattern: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i').test(name);
}

/** The checks of one PR the stage counts, and whether required fell back to all. A required name or a pattern no check reports yet is a pending
 * entry named after it, so the count shows it. */
export function considered(read: CiPrRead, ciChecks: CiChecks, patterns: readonly string[] = []): { checks: CiCheck[]; fellBack: boolean } {
  const missing = (name: string): CiCheck => ({ name, pr: read.url, state: 'pending' });
  const required = read.required ?? [];
  if (ciChecks === 'all' || (ciChecks === 'required' && required.length === 0)) return { checks: read.checks, fellBack: ciChecks === 'required' };
  if (ciChecks === 'required') {
    return { checks: required.flatMap((name) => { const found = read.checks.filter((c) => c.name === name); return found.length > 0 ? found : [missing(name)]; }), fellBack: false };
  }
  const found = read.checks.filter((c) => patterns.some((p) => matches(c.name, p)));
  const unmatched = patterns.filter((p) => !read.checks.some((c) => matches(c.name, p))).map(missing);
  return { checks: [...found, ...unmatched], fellBack: false };
}

// #914: the running block's order: finished first, then running, then queued
const RANK = { finished: 0, running: 1, queued: 2 } as const;
const rankOf = (c: StageCiCheck): number => (c.state !== 'pending' ? RANK.finished : c.startedAt === undefined ? RANK.queued : RANK.running);
const orderKey = (c: StageCiCheck): string => (c.state !== 'pending' ? c.completedAt ?? '' : c.startedAt ?? c.name);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0); // ISO strings in GitHub's one format sort as the instants
// A status context's targetUrl is any integration's text and becomes a link the user clicks: only https reaches the page
const isHttps = (url: string | undefined): url is string => url?.startsWith('https://') === true;

function stageCheck({ name, state, url, startedAt, at }: CiCheck): StageCiCheck {
  return {
    name: cleanName(name), state, ...(isHttps(url) ? { url } : {}), ...(startedAt === undefined ? {} : { startedAt }),
    ...(state === 'pending' || at === undefined ? {} : { completedAt: at }),
  };
}

/** The considered checks as the running block lists them (#914): finished by end time, then running by start time, then queued by name. */
export function stageChecks(checks: readonly CiCheck[]): StageCiCheck[] {
  return checks.map(stageCheck).sort((a, b) => rankOf(a) - rankOf(b) || compare(orderKey(a), orderKey(b)) || compare(a.name, b.name));
}

/** What a read means for the stage: failed as soon as a counted check is a failure; passed when every PR has counted checks, or runs no CI
 * (#11), and all are successes; else pending, with the count, whether no PR is open, and the pending names. fellBack: some PR's required fell back to all.
 * awaiting: nothing failed and a workflow waits for a maintainer's approval, which ends nothing (#854). checks: the considered ones, ordered for the running block (#914). */
export type CiVerdict =
  | { kind: 'pending'; done: number; total: number; waitingPr: boolean; pending: string[]; fellBack: boolean; checks: StageCiCheck[] }
  | { kind: 'passed'; fellBack: boolean }
  | { kind: 'failed'; failed: CiCheck[]; fellBack: boolean; checks: StageCiCheck[] }
  | { kind: 'awaiting'; workflows: string[]; fellBack: boolean; checks: StageCiCheck[] };

export function ciVerdict(reads: readonly CiPrRead[], stage: Pick<Stage, 'ciChecks' | 'checks'>): CiVerdict {
  const each = reads.map((r) => considered(r, stage.ciChecks ?? 'required', stage.checks));
  const fellBack = each.some((c) => c.fellBack);
  const checks = each.flatMap((c) => c.checks);
  const listed = stageChecks(checks); // #914: the same checks the count adds up, so the block's lines explain the card's n/total
  const failed = checks.filter((c) => c.state === 'failure');
  if (failed.length > 0) return { kind: 'failed', failed, fellBack, checks: listed };
  const workflows = [...new Set(reads.flatMap((r) => r.awaiting ?? []))]; // #854: GitHub ran nothing for them, so the counted checks cannot pass yet
  if (workflows.length > 0) return { kind: 'awaiting', workflows, fellBack, checks: listed };
  const pending = checks.filter((c) => c.state === 'pending').map((c) => c.name);
  if (reads.length > 0 && pending.length === 0 && each.every((c, i) => c.checks.length > 0 || reads[i].noCi === true)) return { kind: 'passed', fellBack };
  return { kind: 'pending', done: checks.length - pending.length, total: checks.length, waitingPr: reads.length === 0, pending, fellBack, checks: listed };
}
