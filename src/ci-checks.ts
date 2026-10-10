import { stripVTControlCharacters } from 'node:util';
import { awaitingOf, canPushOf, checkOf, headRollup, isObject, nodesOf, readable, rollupFields, SUITE_FIELDS } from './pr-checks.js';
import { type Alias, aliasedQuery, aliasOf } from './pull-requests.js';
import type { CiCheck, CiChecks, CiPrRead, Stage } from './types.js';

// A PR's CI for a wait-for-CI stage (#834), on top of #758's checks (pr-checks.ts): the same rollup and the same states, plus what the stage
// needs (the head commit, the Actions run behind each check run, the base branch's required checks) and the verdict. Pure.

/** Per PR: its base branch's required checks, the login's permission on its repository (#854) and #758's rollup, with the head's oid, its check
 * suites (#854) and each check run's workflow run. */
export const CI_FIELDS = 'baseRef { refUpdateRule { requiredStatusCheckContexts } } repository { viewerPermission } '
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
    return skipped ? [] : [{ url, head, ...requiredOf(alias), checks, awaiting: awaitingOf(alias.headCommit), canPush: canPushOf(permission) }];
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

/** What a read means for the stage: failed as soon as a counted check is a failure; passed when every PR has counted checks and all are
 * successes; else pending, with the count, whether no PR is open, and the pending names. fellBack: some PR's required fell back to all.
 * awaiting: nothing failed and a workflow waits for a maintainer's approval, which ends nothing (#854). */
export type CiVerdict =
  | { kind: 'pending'; done: number; total: number; waitingPr: boolean; pending: string[]; fellBack: boolean }
  | { kind: 'passed'; fellBack: boolean }
  | { kind: 'failed'; failed: CiCheck[]; fellBack: boolean }
  | { kind: 'awaiting'; workflows: string[]; fellBack: boolean };

export function ciVerdict(reads: readonly CiPrRead[], stage: Pick<Stage, 'ciChecks' | 'checks'>): CiVerdict {
  const each = reads.map((r) => considered(r, stage.ciChecks ?? 'required', stage.checks));
  const fellBack = each.some((c) => c.fellBack);
  const checks = each.flatMap((c) => c.checks);
  const failed = checks.filter((c) => c.state === 'failure');
  if (failed.length > 0) return { kind: 'failed', failed, fellBack };
  const workflows = [...new Set(reads.flatMap((r) => r.awaiting ?? []))]; // #854: GitHub ran nothing for them, so the counted checks cannot pass yet
  if (workflows.length > 0) return { kind: 'awaiting', workflows, fellBack };
  const pending = checks.filter((c) => c.state === 'pending').map((c) => c.name);
  if (reads.length > 0 && pending.length === 0 && each.every((c) => c.checks.length > 0)) return { kind: 'passed', fellBack };
  return { kind: 'pending', done: checks.length - pending.length, total: checks.length, waitingPr: reads.length === 0, pending, fellBack };
}
