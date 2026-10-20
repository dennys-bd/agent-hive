import { addTokens } from './agents/jsonl.js';
import { since, type StartedRun } from './event-derive.js';
import { LIST_MAX, rawText, ZERO_TOKENS, type Correlation, type RecordInput, type RunUsage, type StageOutcome, type Tokens } from './events.js';
import type { AgentId, HookPayload, Worker } from './types.js';
import type { TurnUsage } from './usage.js';

// The human side of a run (#742): what only the hooks tell, kept per pty in memory by the server. A prompt the Hive typed itself is counted in
// and consumed; any other answers an ask, closes a permission prompt or takes the run over. A stage run's tool uses and its last turn's usage
// ride along until it ends. Nothing here survives a restart, and no run does either.

const ELICITATIONS: readonly string[] = ['elicitation_dialog', 'elicitation_url_dialog'];
const PERMISSION = 'permission_prompt';
const TOOLS_MAX = 50; // distinct tool names a stage run counts; any past it lands in OTHER_TOOL
const OTHER_TOOL = 'other';
const OTHER_MODEL = 'other'; // #271: where the models past LIST_MAX add up

/** A stage run that ended (#742): the derivation's outcome and the worker's waits so far; the tracker adds what the hooks told. */
export interface StageRunEnd { ptyId: string; outcome: StageOutcome; waitedMs: number }

// tools: a Map, so a hook's tool name (any local process's text) is only ever a key, `__proto__` and `constructor` included
interface OpenRun { correlation: Correlation; startedAt: number; waitedMs: number; agent?: AgentId; usage?: TurnUsage; tools: ReadonlyMap<string, number> }
// askFlushed: the waitingSince of an ask already written unresolved, so a late prompt neither answers it again nor reads as a takeover
interface PtyTrack { expected: number; takeovers: number[]; lastTool?: string; permission?: { tool: string; since: number }; askFlushed?: string; run?: OpenRun }
interface Applied { track: PtyTrack; records: RecordInput[] }

export interface HumanSignals {
  expectPrompt(ptyId: string): void; // a prompt the Hive is about to type: the next UserPromptSubmit is its own
  openStageRun(run: StartedRun, now: number): void; // a stage run, or a free session's (#271): endStageRun never ends the latter
  usageSince(ptyId: string): number | undefined; // when the open run began: the transcript read counts from there
  freeSessionUsage(ptyId: string): Partial<RunUsage>; // #271: a free session's last turn end's usage for its free_session.ended; {} with no run here
  onHook(ptyId: string, payload: HookPayload, worker: Worker, ids: Correlation, now: number, usage?: TurnUsage): RecordInput[]; // worker: before this hook
  endStageRun(end: StageRunEnd, now: number): RecordInput | undefined; // its stage.ended once; undefined for a run never opened here
  // Every wait still open on the pty, written unresolved once: what a stage end, a run's exit or the quit calls first, so no wait vanishes.
  // worker: as it stood, for its ask or elicitation; undefined when the pty has no worker any more
  flush(ptyId: string, worker: Worker | undefined, ids: Correlation, now: number): RecordInput[];
  prune(live: ReadonlySet<string>): void; // every tracker whose pty is not a live run goes: a run gone, a prompt expected for a pty that never ran
}

const EMPTY: PtyTrack = { expected: 0, takeovers: [] };

const withUsage = (track: PtyTrack, usage?: TurnUsage): PtyTrack => (usage && track.run ? { ...track, run: { ...track.run, usage } } : track);

// A pending permission prompt answered: a tool use after it granted it, a Stop or a prompt denied it
function answered(track: PtyTrack, outcome: 'granted' | 'denied' | 'unresolved', ids: Correlation, now: number): Applied {
  const { permission, ...rest } = track;
  if (!permission) return { track, records: [] };
  return { track: rest, records: [{ event: 'permission.answered', level: 'info', ...ids, outcome, tool: permission.tool, duration_ms: now - permission.since }] };
}

// What the worker waits on that a prompt answers: its own hive_ask, or an elicitation dialog Claude Code opened
function waitKind(worker: Worker): 'ask' | 'elicitation' | undefined {
  if (worker.lastEvent?.kind === 'ask') return 'ask';
  return worker.lastEvent?.kind === 'waiting' && ELICITATIONS.includes(worker.lastEvent.detail ?? '') ? 'elicitation' : undefined;
}

// Which ask a flush wrote: its waitingSince. An ask without one is never remembered, or it would swallow every later ask without one too
const askKey = (worker: Worker): string | undefined => worker.waitingSince;

function onPrompt(track: PtyTrack, worker: Worker, ids: Correlation, now: number): Applied {
  if (track.expected > 0) return { track: { ...track, expected: track.expected - 1 }, records: [] }; // the Hive's own prompt
  const denied = answered(track, 'denied', ids, now);
  const kind = waitKind(worker);
  if (kind && askKey(worker) !== undefined && track.askFlushed === askKey(worker)) return denied; // already written unresolved
  if (kind) return { track: denied.track, records: [...denied.records, { event: 'question.answered', level: 'info', ...ids, kind, outcome: 'answered', duration_ms: since(worker.waitingSince, now) }] };
  if (worker.freeSession) return denied; // the user's own session: every prompt there is theirs, none a takeover
  return { track: { ...denied.track, takeovers: [...denied.track.takeovers, now] }, records: denied.records };
}

// One more use of `tool`: a new name past TOOLS_MAX distinct ones is counted as OTHER_TOOL. A new Map, the given one untouched
function countTool(tools: ReadonlyMap<string, number>, tool: string): ReadonlyMap<string, number> {
  const key = tools.has(tool) || tools.size < TOOLS_MAX ? tool : OTHER_TOOL;
  return new Map(tools).set(key, (tools.get(key) ?? 0) + 1);
}

function onTool(track: PtyTrack, p: HookPayload, ids: Correlation, now: number, before: boolean): Applied {
  const granted = answered(track, 'granted', ids, now);
  if (!before) return granted;
  const tool = rawText(p.tool_name ?? 'tool');
  const { run } = granted.track;
  const counted = run ? { run: { ...run, tools: countTool(run.tools, tool) } } : {};
  return { track: { ...granted.track, lastTool: tool, ...counted }, records: granted.records };
}

// The turn's end: a pending permission denied, each takeover since the last Stop timed to this one
function onStop(track: PtyTrack, ids: Correlation, now: number, usage?: TurnUsage): Applied {
  const denied = answered(withUsage(track, usage), 'denied', ids, now);
  const takeovers = denied.track.takeovers.map((at): RecordInput => ({ event: 'run.takeover', level: 'info', ...ids, outcome: 'ended', duration_ms: now - at }));
  return { track: { ...denied.track, takeovers: [] }, records: [...denied.records, ...takeovers] };
}

function applyHook(track: PtyTrack, p: HookPayload, worker: Worker, ids: Correlation, now: number, usage?: TurnUsage): Applied {
  switch (p.hook_event_name) {
    case 'UserPromptSubmit': return onPrompt(track, worker, ids, now);
    case 'Notification': return { track: p.notification_type === PERMISSION ? { ...track, permission: { tool: track.lastTool ?? 'tool', since: now } } : track, records: [] };
    case 'PreToolUse': return onTool(track, p, ids, now, true);
    case 'PostToolUse': return onTool(track, p, ids, now, false);
    case 'Stop': return onStop(track, ids, now, usage);
    case 'SessionEnd': return { track: withUsage(track, usage), records: [] };
    default: return { track, records: [] };
  }
}

// The waits a run leaves open as it ends: the permission prompt, each takeover with no Stop yet, the ask or elicitation it still waits on
function flushed(track: PtyTrack, worker: Worker | undefined, ids: Correlation, now: number): Applied {
  const permission = answered(track, 'unresolved', ids, now);
  const takeovers = track.takeovers.map((at): RecordInput => ({ event: 'run.takeover', level: 'info', ...ids, outcome: 'unresolved', duration_ms: now - at }));
  const kind = worker && waitKind(worker);
  const key = worker && askKey(worker);
  const open = kind !== undefined && (key === undefined || key !== track.askFlushed);
  const asks: RecordInput[] = open ? [{ event: 'question.answered', level: 'info', ...ids, kind, outcome: 'unresolved', duration_ms: since(worker?.waitingSince, now) }] : [];
  const askFlushed = open && key !== undefined ? { askFlushed: key } : {};
  return { track: { ...permission.track, takeovers: [], ...askFlushed }, records: [...permission.records, ...takeovers, ...asks] };
}

// A run's usage as its end record carries it (#271): the last turn end's, zero before any. tokens_by_model's keys are a transcript's model
// names, cut and capped as the writer does a list's strings
// #271: the split must still sum to `tokens`, so names that clean to the same text add up, and models past LIST_MAX land in OTHER_MODEL
function byModel(tokensByModel: Readonly<Record<string, Tokens>>): Record<string, Tokens> {
  const merged = new Map<string, Tokens>();
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    const clean = rawText(model);
    const key = merged.has(clean) || merged.size < LIST_MAX - 1 ? clean : OTHER_MODEL;
    merged.set(key, addTokens(merged.get(key) ?? ZERO_TOKENS, tokens));
  }
  return Object.fromEntries(merged);
}

function usageFields(usage: TurnUsage | undefined): RunUsage {
  return {
    tokens: usage?.tokens ?? ZERO_TOKENS, subagent_tokens: usage?.subagentTokens ?? ZERO_TOKENS, models: usage?.models ?? [], tokens_by_model: byModel(usage?.tokensByModel ?? {}),
  };
}

function stageEnded(run: OpenRun, end: StageRunEnd, now: number): RecordInput {
  return {
    event: 'stage.ended', level: 'info', ...run.correlation, ...(run.agent === undefined ? {} : { agent: run.agent }), outcome: end.outcome,
    duration_ms: now - run.startedAt, waited_ms: Math.max(0, end.waitedMs - run.waitedMs), ...usageFields(run.usage),
    tool_counts: Object.fromEntries(run.tools), // own data keys, whatever the name
  };
}

export function createHumanSignals(): HumanSignals {
  const tracks = new Map<string, PtyTrack>(); // process state like the ptys: one entry per live run
  const get = (ptyId: string): PtyTrack => tracks.get(ptyId) ?? EMPTY;
  return {
    expectPrompt: (ptyId) => {
      tracks.set(ptyId, { ...get(ptyId), expected: get(ptyId).expected + 1 });
    },
    openStageRun: ({ ptyId, correlation, waitedMs, agent }, now) => {
      tracks.set(ptyId, { ...get(ptyId), run: { correlation, startedAt: now, waitedMs, tools: new Map(), ...(agent === undefined ? {} : { agent }) } });
    },
    usageSince: (ptyId) => tracks.get(ptyId)?.run?.startedAt,
    freeSessionUsage: (ptyId) => {
      const run = tracks.get(ptyId)?.run;
      return run ? usageFields(run.usage) : {};
    },
    onHook: (ptyId, payload, worker, ids, now, usage) => {
      const track = get(ptyId);
      const applied = applyHook(track, payload, worker, { ...ids, ...track.run?.correlation }, now, usage);
      tracks.set(ptyId, applied.track);
      return applied.records;
    },
    endStageRun: (end, now) => {
      const track = tracks.get(end.ptyId);
      if (!track?.run) return undefined;
      const { run, ...rest } = track;
      tracks.set(end.ptyId, rest);
      return stageEnded(run, end, now);
    },
    flush: (ptyId, worker, ids, now) => {
      const track = tracks.get(ptyId);
      const applied = flushed(track ?? EMPTY, worker, { ...ids, ...track?.run?.correlation }, now);
      if (track || applied.records.length > 0) tracks.set(ptyId, applied.track);
      return applied.records;
    },
    prune: (live) => {
      for (const ptyId of [...tracks.keys()]) if (!live.has(ptyId)) tracks.delete(ptyId);
    },
  };
}
