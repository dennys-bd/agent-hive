import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Logger } from './log.js';
import type { Machine } from './machine.js';
import { isUuid } from './orchestrator.js';
import type { AgentId, Session } from './types.js';
import { ranAgent } from './agents.js';
import { runners } from './agents/registry.js';

/** node:fs' constants.COPYFILE_EXCL, libuv's UV_FS_COPYFILE_EXCL: 1 on every OS. Named here so the copy never imports node:fs (#161). */
export const COPYFILE_EXCL = 1;

// One file or folder of a session's transcripts: a path already gone is a debug line, any other failure rejects
async function removePath(machine: Machine, path: string, log: Pick<Logger, 'debug'>): Promise<void> {
  await machine.fs.rm(path, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    log.debug(`transcript ${basename(path)}: already gone`);
  });
}

/**
 * Deletes the transcripts of `sessions` (#236): what each one's own agent's runner lists for it (#929). Claude: `<id>.jsonl` and `<id>/` in
 * the transcript dir of `worktree`, and for a `repo` session (#208) in the main repo's too, where its first open moved it. Codex: its rollout
 * and its subagents' rollouts. Nothing else goes. An id that is not a uuid is skipped: the Hive's own sessions are uuids, and anything looser
 * could name another entry there.
 */
export async function removeTranscripts(
  machine: Machine, worktree: string, repo: string, sessions: (Pick<Session, 'id' | 'repo'> & Partial<Pick<Session, 'agent'>>)[], log: Pick<Logger, 'debug'>,
): Promise<void> {
  for (const session of sessions.filter((s) => isUuid(s.id))) {
    const runner = runners[ranAgent(session)];
    for (const cwd of session.repo ? [worktree, repo] : [worktree]) {
      for (const path of await runner.sessionFiles(machine, cwd, session.id)) await removePath(machine, path, log);
    }
  }
}

// Only a path that is not there is no file (#586): any other stat failure rejects, so a check that could not look never reads as "missing"
const isFile = (machine: Machine, path: string): Promise<boolean> => machine.fs.stat(path).then((s) => s.isFile(), (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
  throw err;
});
const ignoreMissing = (err: NodeJS.ErrnoException): void => {
  if (err.code !== 'ENOENT') throw err;
};

/** A `repo` session's transcript, where `claude --resume` looks from the main repo (#208): it only looks in the dir of its cwd. Moved one way,
 * the first time the session opens, `<id>/` too when it has one; never copied, so there is one transcript. True when it is in the main repo's
 * dir now, false when neither dir has it or the id is not a session id. */
export async function adoptTranscript(machine: Machine, worktree: string, repo: string, id: string, agent: AgentId): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [from, to] = [runners[agent].transcriptDir(machine, worktree), runners[agent].transcriptDir(machine, repo)];
  if (from === undefined || to === undefined) return false; // #929: an agent with no transcript dir has nothing to move
  if (await isFile(machine, join(to, `${id}.jsonl`))) return true;
  if (!(await isFile(machine, join(from, `${id}.jsonl`)))) return false;
  await machine.fs.mkdir(to, { recursive: true });
  for (const name of [`${id}.jsonl`, id]) await machine.fs.rename(join(from, name), join(to, name)).catch(ignoreMissing);
  return true;
}

// One cwd's transcript of session `id`: <id>.jsonl in its transcript dir, or, for an agent that keeps none per cwd (Codex, #929), the
// session's own file among those its runner lists, always first (#933)
async function transcriptIn(machine: Machine, cwd: string, id: string, agent: AgentId): Promise<string | undefined> {
  const dir = runners[agent].transcriptDir(machine, cwd);
  if (dir === undefined) return (await runners[agent].sessionFiles(machine, cwd, id))[0];
  return (await isFile(machine, join(dir, `${id}.jsonl`))) ? join(dir, `${id}.jsonl`) : undefined;
}

/** A session's transcript as its agent's resume finds it from one of `cwds` (#587): the first, in order, that has it. */
export async function findTranscript(machine: Machine, cwds: string[], id: string, agent: AgentId): Promise<string | undefined> {
  if (!isUuid(id)) return undefined;
  for (const cwd of cwds) {
    const found = await transcriptIn(machine, cwd, id, agent);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A copy's temporary transcript (#587): <id>.jsonl from the first of `from` that has it into `to`'s transcript dir, where `--resume` looks. Never
 * <id>/ (subagents are not the conversation) and never over a file already there (the link refuses it): that one, or one dir for both, is `same`.
 * An agent with no dir per cwd (Codex) forks the source by id from anywhere (#933): found is `same`, nothing copied. */
export async function copyTranscript(machine: Machine, from: string[], to: string, id: string, agent: AgentId): Promise<'copied' | 'same' | 'missing'> {
  const dir = runners[agent].transcriptDir(machine, to);
  const source = await findTranscript(machine, from, id, agent);
  if (source === undefined) return 'missing';
  if (dir === undefined) return 'same';
  const target = join(dir, `${id}.jsonl`);
  if (source === target) return 'same';
  await machine.fs.mkdir(dir, { recursive: true });
  // Copied under a name of its own, then linked in: link fails with EEXIST atomically, so a failure never removes a transcript already there
  const staged = join(dir, `.${id}.${randomUUID()}.tmp`);
  try {
    await machine.fs.copyFile(source, staged, COPYFILE_EXCL);
    return await machine.fs.link(staged, target).then(() => 'copied' as const, (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return 'same' as const; // not ours: never removed
      throw err;
    });
  } finally {
    await machine.fs.rm(staged, { force: true });
  }
}

/** The temporary <id>.jsonl a copy put in `dir` (#587), once the new session has its own: that file only. Gone already is a debug line. */
export async function dropCopiedTranscript(machine: Machine, dir: string, id: string, log: Pick<Logger, 'debug'>): Promise<void> {
  if (!isUuid(id)) return;
  await machine.fs.rm(join(dir, `${id}.jsonl`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    log.debug(`transcript ${id}.jsonl: already gone`);
  });
}
