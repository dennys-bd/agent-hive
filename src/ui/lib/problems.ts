// The problems list's data (#782): a language server's diagnostics and a command-line checker's findings as one kind of problem, deduplicated,
// grouped by file and ordered as the list shows them. Pure: diagnostics-store.ts keeps the state and reads through this.

export type Severity = 'error' | 'warning' | 'info';
export interface Counts { errors: number; warnings: number; infos: number }
/** One finding (#782), 1-based. source: the server or checker that reported it; fromServer: a language server's, which follows typing;
 * isStale: its checker runs again, or failed, since. */
export interface Problem {
  path: string; line: number; column: number; endLine?: number; endColumn?: number; severity: Severity; message: string; code?: string;
  source: string; fromServer: boolean; isStale?: boolean;
}
/** One file of the list (#782): its problems by line, its counts, and its most severe problem, which colours its name. */
export interface ProblemGroup { path: string; worst: Severity; counts: Counts; problems: Problem[] }

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
export const ZERO: Counts = { errors: 0, warnings: 0, infos: 0 };
export const addCounts = (a: Counts, b: Counts): Counts => ({ errors: a.errors + b.errors, warnings: a.warnings + b.warnings, infos: a.infos + b.infos });
/** Errors, warnings and infos of a list (#780, #782). */
export const countsOf = (list: readonly Problem[]): Counts => ({
  errors: list.filter((p) => p.severity === 'error').length,
  warnings: list.filter((p) => p.severity === 'warning').length,
  infos: list.filter((p) => p.severity === 'info').length,
});

const keyOf = (p: Problem): string | undefined => (p.code === undefined ? undefined : `${p.path}\0${p.line}\0${p.code}`);

/** One problem per path, line and code (#782): a checker's copy of what a language server reports goes (tsc and typescript-language-server
 * report the same errors, and the server's follows typing). A problem without a code is never a duplicate. */
export function dedupe(list: readonly Problem[]): Problem[] {
  const fromServers = new Set(list.filter((p) => p.fromServer).map(keyOf).filter((key): key is string => key !== undefined));
  return list.filter((p) => {
    const key = keyOf(p);
    return p.fromServer || key === undefined || !fromServers.has(key);
  });
}

const worstOf = (list: readonly Problem[]): Severity => list.reduce<Severity>((worst, p) => (RANK[p.severity] < RANK[worst] ? p.severity : worst), 'info');

/** The list's groups (#782): files with an error first, then with a warning, then by path; a file's problems by line, then column. */
export function groupProblems(list: readonly Problem[]): ProblemGroup[] {
  const byPath = new Map<string, Problem[]>(); // built here, never shared before it is returned
  for (const p of list) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
  const groups = [...byPath].map(([path, found]): ProblemGroup => {
    const sorted = [...found].sort((a, b) => a.line - b.line || a.column - b.column);
    return { path, worst: worstOf(sorted), counts: countsOf(sorted), problems: sorted };
  });
  return groups.sort((a, b) => RANK[a.worst] - RANK[b.worst] || a.path.localeCompare(b.path));
}
