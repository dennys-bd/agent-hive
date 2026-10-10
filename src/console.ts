// The daemon's console (#353): the output of the runs that are not a terminal, grouped in channels by what produced them. Process state like
// the pty host: in memory until the next boot, never persisted and never in State. Pure bookkeeping, no I/O. The page imports the helpers too.

export type ChannelKind = 'command' | 'setup' | 'format' | 'lsp' | 'check' | 'stage'; // setup: a task's worktree setup (#351); format: a formatter's runs on save (#749); lsp: a language server (#780); check: a command-line checker's runs (#782); stage: a commands stage (#755)
/** Every kind a channel may be, for a reader that checks one (the page's GET /console). */
export const CHANNEL_KINDS: readonly ChannelKind[] = ['command', 'setup', 'format', 'lsp', 'check', 'stage'];
/** One console channel. id: `command:<workspace>:<name>`, `format:<workspace>:<name>`, `lsp:<workspace>:<server>`, `check:<workspace>:<checker>`, `stage:<stage>` or `setup`; label: `<workspace> · <name>`, `stage · <stage>` or `Setup worktree`. */
export interface ChannelInfo { id: string; kind: ChannelKind; label: string }
/** Where a channel's last run is (#537): still live, or how the last one to end did. What the footer's console chip dots. */
export type ChannelStatus = 'running' | 'failed' | 'done';
export const CHANNEL_STATUSES: readonly ChannelStatus[] = ['running', 'failed', 'done'];
/** A channel as GET /console lists it: newest run first, each with its status. */
export interface ChannelEntry extends ChannelInfo { status: ChannelStatus }
/** A channel as GET /console/:id answers it: its finished runs joined, in the order they ended, and its live runs in start order, each with the
 * header the page writes before attaching it (the pty never printed it). status: where the runs it returns are (#755): live, else how the last
 * to end did, so a stage's tab with a run group reads its own execution. */
export interface ChannelView { history: string; live: { ptyId: string; header: string }[]; status: ChannelStatus }

export interface ConsoleStore {
  begin(channel: ChannelInfo, ptyId: string, header: string, group?: string): void; // a run starts: its header line is its first output; group: the execution it belongs to (#755)
  append(ptyId: string, data: string): void;
  end(ptyId: string, exitCode?: number): void; // the run joins its channel's history, after the runs that ended before it; non-zero: failed
  channels(): ChannelEntry[];
  clear(id: string): boolean; // the channel's finished runs go (the drawer's limpar, #537); its live ones stay. false: unknown channel
  history(id: string, group?: string): ChannelView | undefined; // undefined: unknown channel; group: only that group's runs (#755)
}

/** A workspace's run command as a channel: every run of it lands here, whatever the task. */
export const commandChannel = (workspace: string, name: string): ChannelInfo =>
  ({ id: `command:${workspace}:${name}`, kind: 'command', label: `${workspace} · ${name}` });

/** A workspace's formatter as a channel (#749): every save it formats lands here, whatever the task, as a command's runs do. */
export const formatChannel = (workspace: string, name: string): ChannelInfo =>
  ({ id: `format:${workspace}:${name}`, kind: 'format', label: `${workspace} · ${name}` });

/** A workspace's language server as a channel (#780): each process start is a run of it, whatever the activity. */
export const lspChannel = (workspace: string, server: string): ChannelInfo =>
  ({ id: `lsp:${workspace}:${server}`, kind: 'lsp', label: `${workspace} · ${server}` });

/** A workspace's command-line checker as a channel (#782): every run of it lands here, whatever the activity, as a formatter's do. */
export const checkChannel = (workspace: string, id: string): ChannelInfo =>
  ({ id: `check:${workspace}:${id}`, kind: 'check', label: `${workspace} · ${id}` });

/** A commands stage as a channel (#755): one per stage, shared by every task, each command a run of it. The stage is encoded, so a `:` or a
 * `/` in it never splits the id, which stays one path segment of GET /console/:id. */
export const stageChannel = (stage: string): ChannelInfo =>
  ({ id: `stage:${encodeURIComponent(stage)}`, kind: 'stage', label: `stage · ${stage}` });

/** A pipe's output for the console's xterm, which moves down on \n without going back to the first column: \r\n, as a pty prints. */
export const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

/** Every worktree setup's channel (#351): one for all tasks, so the channel select groups setups as one kind of thing; each setup is a run
 * in it, whose header names its task. */
export const SETUP_CHANNEL: ChannelInfo = { id: 'setup', kind: 'setup', label: 'Setup worktree' };

/** A task's worktree setup run's id in SETUP_CHANNEL (#351): per task, since the lock allows one setup per task at a time. What Task.setup holds. */
export const setupRunId = (taskId: string): string => `setup:${taskId}`;

/** What a worktree run in SETUP_CHANNEL is (#654): the setup that prepares the worktree, or the teardown before it goes. */
export type WorktreeRunKind = 'setup' | 'teardown';

/** A teardown run's id in SETUP_CHANNEL (#654): `teardown:<taskId>` for a task, `teardown:<workspace>:<slug>` for an orphan. No `/`, since
 * GET /console/:id takes one path segment; never a setup's id, so the two never share a run. */
export const teardownRunId = (key: string): string => `teardown:${key}`;

/** An orphan's teardown run id (#654): its workspace and slug encoded, since the slug is a folder name the worker chose and a `:` in it
 * must not make one orphan's id another's. */
export const orphanTeardownRunId = (workspace: string, slug: string): string =>
  teardownRunId(`${encodeURIComponent(workspace)}:${encodeURIComponent(slug)}`);

const pad = (n: number): string => String(n).padStart(2, '0');

// A control character in the label (an ESC from an orphan's folder name) would reach the console's terminal: it is dropped.
const CONTROL = /\p{Cc}/gu; // C0, DEL and C1
/** The line a run opens with: what it is for (`#<task id>` or an orphan's slug), its kind when it is a worktree run, and the local time. */
export const runHeader = (label: string, at: Date, kind?: WorktreeRunKind): string => {
  const shown = label.replace(CONTROL, '');
  return `── ${kind === undefined ? shown : `${shown} · ${kind}`} · ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ──\r\n`;
};

/** The line a run command's console run ends with when its timeout stopped it (#511). */
export const timeoutLine = (timeout: string): string => `\r\n── tempo esgotado (${timeout}) ──\r\n`;

// A setup run's colors (#576), as SGR codes in its text: the console's xterm renders them and the store keeps them with the output, so the
// history replays them. The palette maps each to a token (ConsolePanel.tsx).
const BRIGHT_WHITE = 97;
const GREEN = 32;
const RED = 31;
const sgr = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;

/** A command line of a run (`> …`), bright white like a workspace command's own echo (COMMAND_ECHO in spawn.ts). */
export const commandLine = sgr(BRIGHT_WHITE);
/** A step that went through: `ok <ms>ms`, and a run's summary line (`setup ok · <n> steps · <ms>ms`). */
export const okLine = sgr(GREEN);
/** A failure's message, or the failed run's last line; a multi-line one keeps its color across the lines until the reset. */
export const failLine = sgr(RED);

const HEADER = /^── (.+) · (\d\d:\d\d):\d\d ──/;

/** The run select's label, `<label>[ · <kind>] · HH:MM`, read back from what runHeader wrote. */
export function runLabel(header: string): string {
  const match = HEADER.exec(header);
  return match ? `${match[1]} · ${match[2]}` : header.trim();
}

// A run's text and the lines (\n) it holds, counted as it grows: a trim never rescans a channel.
interface Text { text: string; lines: number; group?: string; failed?: boolean } // group: the stage execution it belongs to; failed: a finished run's non-zero exit
interface Run extends Text { ptyId: string; header: string }
interface Channel { info: ChannelInfo; done: Text[]; live: Run[]; failed: boolean } // failed: the last run to end exited non-zero

const countLines = (text: string): number => text.split('\n').length - 1;

// `t` without its first `n` lines; the callers never ask for more than it holds
function dropLines(t: Text, n: number): Text {
  let at = 0;
  for (let i = 0; i < n; i += 1) at = t.text.indexOf('\n', at) + 1;
  return { text: t.text.slice(at), lines: t.lines - n };
}

// A line cap alone never bounds output that never breaks a line (a progress bar redrawn with \r, a TUI's cursor moves): the channel also
// keeps at most this many characters per allowed line.
export const CHARS_PER_LINE = 512;

// A measure of a run's text and how to drop its first `n` units of it
interface Measure { size(t: Text): number; drop(t: Text, n: number): Text }
const LINES: Measure = { size: (t) => t.lines, drop: dropLines };
const CHARS: Measure = { size: (t) => t.text.length, drop: (t, n) => { const text = t.text.slice(n); return { text, lines: countLines(text) }; } };

// The channel held to `max` units of `m`: they go from the head of the oldest finished run first (one left with none goes), then from the
// head of the oldest live run, whose header stays in its view.
function cutHeads(channel: Channel, max: number, m: Measure): Channel {
  let excess = [...channel.done, ...channel.live].reduce((sum, t) => sum + m.size(t), 0) - max;
  if (excess <= 0) return channel;
  const done = channel.done.flatMap((run): Text[] => {
    if (excess <= 0) return [run];
    const cut = Math.min(excess, m.size(run));
    excess -= cut;
    return cut === m.size(run) ? [] : [{ ...run, ...m.drop(run, cut) }]; // its group and failure stay
  });
  const live = channel.live.map((run): Run => {
    const cut = Math.min(excess, m.size(run));
    excess -= cut;
    return cut === 0 ? run : { ...run, ...m.drop(run, cut) };
  });
  return { ...channel, done, live };
}

// `max` lines, then `max * CHARS_PER_LINE` characters
const trimmed = (channel: Channel, max: number): Channel => cutHeads(cutHeads(channel, max, LINES), max * CHARS_PER_LINE, CHARS);

const statusOf = (channel: Channel): ChannelStatus => {
  if (channel.live.length > 0) return 'running';
  return channel.failed ? 'failed' : 'done';
};

// The channel's runs of one group (#755), its status read over them alone
const groupStatus = (done: Text[], live: Run[]): ChannelStatus => {
  if (live.length > 0) return 'running';
  return done.at(-1)?.failed === true ? 'failed' : 'done';
};

/** The console's channels. `maxLines` is read on every trim, so a Settings save applies to the next output without a new store. An unknown
 * pty id on append or end does nothing. `onChange` hears a begin and a run's end, the two that add a channel or change its status, and never an
 * append: output is read through the channel's own route, and a notice per line would flood the state stream. A begin moves its channel to the head of the list (#537): the chip shows the newest command. */
export function createConsoleStore(maxLines: () => number, onChange: () => void = () => undefined): ConsoleStore {
  const channels = new Map<string, Channel>();
  const owners = new Map<string, string>(); // a live run's pty id → its channel's id
  const put = (channel: Channel): void => {
    channels.set(channel.info.id, trimmed(channel, maxLines()));
  };
  // The live run `ptyId` changed through `change`, in a new channel; nothing for an unknown one
  const withRun = (ptyId: string, change: (channel: Channel, run: Run) => Channel): void => {
    const channel = channels.get(owners.get(ptyId) ?? '');
    const run = channel?.live.find((r) => r.ptyId === ptyId);
    if (channel && run) put(change(channel, run));
  };
  return {
    begin(info, ptyId, header, group) {
      const channel = channels.get(info.id) ?? { info, done: [], live: [], failed: false };
      channels.delete(info.id); // re-set below at the Map's end: the newest begin last, listed first
      owners.set(ptyId, info.id);
      put({ ...channel, live: [...channel.live, { ptyId, header, text: header, lines: countLines(header), ...(group === undefined ? {} : { group }) }] });
      onChange();
    },
    append(ptyId, data) {
      withRun(ptyId, (channel, run) => ({
        ...channel, live: channel.live.map((r) => (r === run ? { ...r, text: r.text + data, lines: r.lines + countLines(data) } : r)),
      }));
    },
    end(ptyId, exitCode) {
      withRun(ptyId, (channel, run) => ({
        ...channel,
        done: [...channel.done, { text: run.text, lines: run.lines, failed: (exitCode ?? 0) !== 0, ...(run.group === undefined ? {} : { group: run.group }) }],
        live: channel.live.filter((r) => r !== run), failed: (exitCode ?? 0) !== 0,
      }));
      const isLive = owners.has(ptyId);
      owners.delete(ptyId);
      if (isLive) onChange();
    },
    channels: () => [...channels.values()].reverse().map((channel) => ({ ...channel.info, status: statusOf(channel) })),
    clear(id) {
      const channel = channels.get(id);
      if (channel) channels.set(id, { ...channel, done: [], failed: false }); // nothing failed is left to show
      return channel !== undefined;
    },
    history(id, group) {
      const channel = channels.get(id);
      if (!channel) return undefined;
      const mine = (r: Text): boolean => group === undefined || r.group === group;
      const done = channel.done.filter(mine);
      const live = channel.live.filter(mine);
      return {
        history: done.map((run) => run.text).join(''), live: live.map(({ ptyId, header }) => ({ ptyId, header })),
        status: group === undefined ? statusOf(channel) : groupStatus(done, live),
      };
    },
  };
}
