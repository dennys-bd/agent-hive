export type Status = 'vazio' | 'trabalhando' | 'esperando_voce' | 'aguardando_review';
export type StatusKey = 'queue' | 'working' | 'review';

export interface Task {
  itemId: string;
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface Slot {
  id: string;
  workerId?: string; // uuid per spawn; stale exit/hook signals from a previous occupant are ignored
  status: Status;
  draining?: boolean;
  task?: Task;
  slug?: string;
  worktree?: string;
  branch?: string;
  itermSessionId?: string;
  startedAt?: string;
  lastEvent?: string;
  prUrl?: string;
  question?: string;
}

export interface State {
  maxConcurrent: number;
  slots: Slot[];
  queue: Task[];
  lastPolledAt?: string;
  error?: string;
}

export interface Config {
  project: { owner: string; number: number };
  status: Record<StatusKey, string>;
  maxConcurrent: number;
  port: number;
  claudeArgs: string[];
  promptTemplate: string;
}

export interface HookPayload {
  hook_event_name: string;
  cwd?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export type HiveEvent =
  | { type: 'boot'; aliveSlugs: string[] }
  | { type: 'poll'; tasks: Task[] }
  | { type: 'setMax'; max: number }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string }
  | { type: 'exit'; workerId: string }
  | { type: 'kill'; slotId: string }
  | { type: 'spawned'; workerId: string; itermSessionId: string }
  | { type: 'error'; message?: string };

export type Effect =
  | { type: 'spawn'; slot: Slot }
  | { type: 'setStatus'; itemId: string; key: StatusKey }
  | { type: 'kill'; slug: string; workerId: string };
