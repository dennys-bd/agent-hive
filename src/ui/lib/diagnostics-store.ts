// The language servers' and checkers' states and problems as the page shows them (#780, #782): the editor bar, the problems list, the editor
// tab and the files tree read it after useDiagnostics. Module state, as editor-models.ts keeps its buffers: a client or a check writes, every
// reader re-renders on the version. A server's problems show only while it is ready; a check's stay while it runs again or after it failed,
// stale. Grouping, ordering and dedup are problems.ts's.
import { type Counts, countsOf, dedupe, groupProblems, type Problem, type ProblemGroup } from '@/lib/problems';
import type { CheckDiagnostic, CheckerId, CliCheckerId, FormatLog, LanguageId, ServerId } from '../../types';

export type { Counts, Problem, ProblemGroup } from '@/lib/problems';
/** A client's state (#780): off is a workspace out of the server's scope, which shows nothing. */
export type ServerPhase = { phase: 'starting' } | { phase: 'ready' } | { phase: 'failed'; reason: string } | { phase: 'absent'; reason: string } | { phase: 'off' };
export interface FileServer { server: ServerId; language: LanguageId; state: ServerPhase; log?: FormatLog }
/** A command-line checker's answer as the store keeps it (#782); a failure's log is absent when the request itself failed. */
export type CheckOutcome =
  | { state: 'done'; scope: 'file' | 'project'; diagnostics: CheckDiagnostic[] } | { state: 'failed'; reason: string; log?: FormatLog } | { state: 'absent' };
export type CheckPhase = 'running' | 'done' | 'failed' | 'absent';
/** A command-line checker of the activity (#782): at is when its last done answer came, what the list's running line names. */
export interface CheckStatus { checker: CliCheckerId; phase: CheckPhase; at?: number; reason?: string; log?: FormatLog }
/** One entry of the bar besides the language's own server (#782): a checker of the open file, of either kind. */
export interface Source { name: string; phase: 'starting' | 'ready' | 'running' | 'failed' | 'absent'; reason?: string; log?: FormatLog }

interface Client { activityId: string; server: ServerId; checker?: CheckerId; state: ServerPhase; log?: FormatLog; problems: ReadonlyMap<string, readonly Problem[]> }
type TargetState = Omit<CheckStatus, 'checker'>;
// targets: a file checker's phase per file, a project checker's under '' (its target): one file's answer never touches another's
interface Check { activityId: string; checker: CliCheckerId; problems: readonly Problem[]; targets: ReadonlyMap<string, TargetState> }

const clients = new Map<string, Client>();
const bound = new Map<string, ReadonlyMap<string, LanguageId>>(); // activity + path → its clients' keys and the file's language
const checks = new Map<string, Check>(); // activity + checker
const checkBound = new Map<string, readonly CliCheckerId[]>(); // activity + path → the command-line checkers that run for it
const listeners = new Set<() => void>();
let version = 0;

const fileKey = (activityId: string, path: string): string => `${activityId}\0${path}`;
const checkKey = (activityId: string, checker: CliCheckerId): string => `${activityId}\0${checker}`;
const notify = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};

/** A client's state (#780); its problems go when it leaves ready, and its log is kept from the hello. checker: a checker's own server (#782). */
export function setClient(key: string, activityId: string, server: ServerId, state: ServerPhase, log?: FormatLog, checker?: CheckerId): void {
  const kept = clients.get(key);
  const problems = state.phase === 'ready' ? (kept?.problems ?? new Map<string, readonly Problem[]>()) : new Map<string, readonly Problem[]>();
  const shown = log ?? kept?.log;
  clients.set(key, { activityId, server, state, problems, ...(shown ? { log: shown } : {}), ...(checker ? { checker } : {}) });
  notify();
}

/** The problems a server reported for a file (#780, #782), only while ready; a file with none leaves the map. */
export function setDiagnostics(key: string, path: string, list: readonly Problem[]): void {
  const client = clients.get(key);
  if (client === undefined || client.state.phase !== 'ready') return;
  const next = new Map(client.problems);
  if (list.length === 0) next.delete(path);
  else next.set(path, list);
  clients.set(key, { ...client, problems: next });
  notify();
}

// The file's clients without `key`; the file leaves the map with its last
function unbound(file: string, key: string): void {
  const keys = new Map<string, LanguageId>(bound.get(file));
  keys.delete(key);
  if (keys.size === 0) bound.delete(file);
  else bound.set(file, keys);
}

export function dropClient(key: string): void {
  clients.delete(key);
  for (const [file, keys] of [...bound]) if (keys.has(key)) unbound(file, key);
  notify();
}

export function bindFile(activityId: string, path: string, key: string, language: LanguageId): void {
  const file = fileKey(activityId, path);
  bound.set(file, new Map<string, LanguageId>([...(bound.get(file) ?? []), [key, language]]));
  notify();
}

/** One client leaves the file (#782): its language's server and its checkers' each leave on their own. */
export function unbindFile(activityId: string, path: string, key: string): void {
  const file = fileKey(activityId, path);
  if (!bound.get(file)?.has(key)) return;
  unbound(file, key);
  notify();
}

/** The language's own server of the file the pane shows (#780); undefined when none serves it. */
export function fileServer(activityId: string, path: string): FileServer | undefined {
  for (const [key, language] of bound.get(fileKey(activityId, path)) ?? []) {
    const client = clients.get(key);
    if (client !== undefined && client.checker === undefined) return { server: client.server, language, state: client.state, ...(client.log ? { log: client.log } : {}) };
  }
  return undefined;
}

const toProblem = (checker: CliCheckerId) => (d: CheckDiagnostic): Problem => ({ ...d, source: checker, fromServer: false });

const withTarget = (kept: Check | undefined, target: string, state: TargetState): Map<string, TargetState> => new Map([...(kept?.targets ?? []), [target, state]]);
const phaseAt = (kept: Check | undefined, target: string): Pick<TargetState, 'at'> => { const at = kept?.targets.get(target)?.at; return at === undefined ? {} : { at }; };

/** A command-line checker's run started for `target` (#782): its previous problems stay, stale, until its answer. */
export function checkStarted(activityId: string, checker: CliCheckerId, target: string): void {
  const kept = checks.get(checkKey(activityId, checker));
  checks.set(checkKey(activityId, checker), { activityId, checker, problems: kept?.problems ?? [], targets: withTarget(kept, target, { phase: 'running', ...phaseAt(kept, target) }) });
  notify();
}

/** A command-line checker's answer for `target` (#782): a file check replaces its problems for that file only (a finding about another file
 * dropped), a project check for the whole activity; a failure keeps the previous ones, stale; absent has none. Only `target`'s phase changes. */
export function setCheck(activityId: string, checker: CliCheckerId, outcome: CheckOutcome, target: string): void {
  const key = checkKey(activityId, checker);
  const kept = checks.get(key);
  const base = { activityId, checker };
  if (outcome.state === 'done') {
    const fresh = outcome.diagnostics.filter((d) => outcome.scope === 'project' || d.path === target).map(toProblem(checker));
    const others = outcome.scope === 'file' ? (kept?.problems ?? []).filter((p) => p.path !== target) : [];
    checks.set(key, { ...base, problems: [...others, ...fresh], targets: withTarget(kept, target, { phase: 'done', at: Date.now() }) });
  } else if (outcome.state === 'failed') {
    const failed: TargetState = { ...phaseAt(kept, target), phase: 'failed', reason: outcome.reason, ...(outcome.log ? { log: outcome.log } : {}) };
    checks.set(key, { ...base, problems: kept?.problems ?? [], targets: withTarget(kept, target, failed) });
  } else {
    const problems = target === '' ? [] : (kept?.problems ?? []).filter((p) => p.path !== target);
    checks.set(key, { ...base, problems, targets: withTarget(kept, target, { phase: 'absent' }) });
  }
  notify();
}

/** Whether the checker has an answer, or runs, for `target` in the activity (#782): a file opened again asks no new run, unless the checker
 * was absent or failed there, which it may not be on the next open. */
export function hasCheck(activityId: string, checker: CliCheckerId, target: string): boolean {
  const phase = checks.get(checkKey(activityId, checker))?.targets.get(target)?.phase;
  return phase === 'running' || phase === 'done';
}
/** A checker's problems on one file (#782): what its markers show. */
export const checkProblems = (activityId: string, checker: CliCheckerId, path: string): readonly Problem[] => {
  const own = (checks.get(checkKey(activityId, checker))?.problems ?? []).filter((p) => p.path === path);
  const servers = readyOf(activityId).flatMap((c) => c.problems.get(path) ?? []);
  return dedupe([...servers, ...own]).filter((p) => !p.fromServer); // a server's squiggle already marks it: tsc and its language server draw one, not two
};
const checksOf = (activityId: string): Check[] => [...checks.values()].filter((c) => c.activityId === activityId);
const PRECEDENCE: readonly CheckPhase[] = ['running', 'failed', 'done', 'absent']; // what one line says of a checker with several targets

// A checker's one line over its targets: the first phase of the precedence, the latest answer's time
function statusOf(check: Check): CheckStatus {
  const states = [...check.targets.values()];
  const shown = PRECEDENCE.flatMap((phase) => states.filter((s) => s.phase === phase))[0] ?? { phase: 'absent' as const };
  const at = Math.max(...states.map((s) => s.at ?? 0));
  const { reason, log } = shown;
  return { checker: check.checker, phase: shown.phase, ...(at > 0 ? { at } : {}), ...(reason === undefined ? {} : { reason }), ...(log ? { log } : {}) };
}

/** The activity's command-line checkers and where each is (#782), in the order they first ran. */
export const checkStatuses = (activityId: string): CheckStatus[] => checksOf(activityId).map(statusOf);

/** The command-line checkers that run for an open file (#782): the bar shows them before their first answer. */
export function bindChecks(activityId: string, path: string, ids: readonly CliCheckerId[]): void {
  checkBound.set(fileKey(activityId, path), ids);
  notify();
}
export function unbindChecks(activityId: string, path: string): void {
  if (checkBound.delete(fileKey(activityId, path))) notify();
}

const SERVER_SOURCE: Record<ServerPhase['phase'], Source['phase'] | undefined> = { starting: 'starting', ready: 'ready', failed: 'failed', absent: 'absent', off: undefined };
const CHECK_SOURCE: Record<CheckPhase, Source['phase']> = { running: 'running', done: 'ready', failed: 'failed', absent: 'absent' };

// A checker server's client as a bar entry; none for the language's own server or one out of scope
function serverSource(key: string): Source[] {
  const client = clients.get(key);
  const phase = client === undefined ? undefined : SERVER_SOURCE[client.state.phase];
  if (client?.checker === undefined || phase === undefined) return [];
  const reason = 'reason' in client.state ? client.state.reason : undefined;
  return [{ name: client.checker, phase, ...(reason === undefined ? {} : { reason }), ...(client.log ? { log: client.log } : {}) }];
}

/** The bar's checkers of a file (#782): its checker servers' clients, then its command-line checkers, starting until their first answer. */
export function fileSources(activityId: string, path: string): Source[] {
  const servers = [...(bound.get(fileKey(activityId, path))?.keys() ?? [])].flatMap(serverSource);
  const cli = (checkBound.get(fileKey(activityId, path)) ?? []).map((checker): Source => {
    const state = checks.get(checkKey(activityId, checker))?.targets.get(path) ?? checks.get(checkKey(activityId, checker))?.targets.get('');
    return { name: checker, phase: state === undefined ? 'starting' : CHECK_SOURCE[state.phase], ...(state?.reason === undefined ? {} : { reason: state.reason }), ...(state?.log ? { log: state.log } : {}) };
  });
  return [...servers, ...cli];
}

const readyOf = (activityId: string): Client[] => [...clients.values()].filter((c) => c.activityId === activityId && c.state.phase === 'ready');

// A problem is stale while its own target runs again or failed: a file's for its file, a project checker's (target '') for all
function isStale(check: Check, problem: Problem): boolean {
  const phase = (check.targets.get(problem.path) ?? check.targets.get(''))?.phase;
  return phase === 'running' || phase === 'failed';
}

// Every problem of the activity (#782): its ready clients' and its checks', a check's stale while it runs again or after it failed; deduplicated
function allOf(activityId: string): Problem[] {
  const fromClients = readyOf(activityId).flatMap((c) => [...c.problems.values()].flat());
  const fromChecks = checksOf(activityId).flatMap((c) => c.problems.map((p) => (isStale(c, p) ? { ...p, isStale: true } : p)));
  return dedupe([...fromClients, ...fromChecks]);
}

/** The problems list's groups for the activity (#782). */
export const problems = (activityId: string): ProblemGroup[] => groupProblems(allOf(activityId));
/** A file's counts over both sources, a duplicate once (#780, #782); zero while nothing reported it. */
export const fileCounts = (activityId: string, path: string): Counts => countsOf(allOf(activityId).filter((p) => p.path === path));
/** Every file of the activity with a problem and its counts (#780, #782), in the list's order. */
export const activityCounts = (activityId: string): ReadonlyMap<string, Counts> => new Map(problems(activityId).map((g) => [g.path, g.counts]));
/** The sources that answered for the activity (#782): its ready clients and its done checks, what the empty list names. */
export const activitySources = (activityId: string): string[] =>
  [...new Set([...readyOf(activityId).map((c) => c.checker ?? c.server), ...checksOf(activityId).filter((c) => [...c.targets.values()].some((t) => t.phase === 'done')).map((c) => c.checker)])];

/** The folders holding a file with an error (#780): their names turn destructive; a warning does not climb. */
export const foldersWithErrors = (counts: ReadonlyMap<string, Counts>): ReadonlySet<string> =>
  new Set([...counts].filter(([, c]) => c.errors > 0).flatMap(([path]) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const snapshot = (): number => version;

/** Forgets everything (a test's reset). */
export function resetDiagnostics(): void {
  clients.clear();
  bound.clear();
  checks.clear();
  checkBound.clear();
  notify();
}
