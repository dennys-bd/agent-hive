import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Logger } from './log.js';
import { isUuid } from './orchestrator.js';
import type { AgentId, Session } from './types.js';
import { ranAgent } from './agents.js';
import { runners } from './agents/registry.js';

// One file or folder of a session's transcripts: a path already gone is a debug line, any other failure rejects
async function removePath(path: string, log: Pick<Logger, 'debug'>): Promise<void> {
  await rm(path, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
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
  worktree: string, repo: string, sessions: (Pick<Session, 'id' | 'repo'> & Partial<Pick<Session, 'agent'>>)[], log: Pick<Logger, 'debug'>, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const session of sessions.filter((s) => isUuid(s.id))) {
    const runner = runners[ranAgent(session)];
    for (const cwd of session.repo ? [worktree, repo] : [worktree]) {
      for (const path of await runner.sessionFiles(cwd, session.id, env)) await removePath(path, log);
    }
  }
}

const isFile = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);
const ignoreMissing = (err: NodeJS.ErrnoException): void => {
  if (err.code !== 'ENOENT') throw err;
};

/** A `repo` session's transcript, where `claude --resume` looks from the main repo (#208): it only looks in the dir of its cwd. Moved one way,
 * the first time the session opens, `<id>/` too when it has one; never copied, so there is one transcript. True when it is in the main repo's
 * dir now, false when neither dir has it or the id is not a session id. */
export async function adoptTranscript(worktree: string, repo: string, id: string, agent: AgentId, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [from, to] = [runners[agent].transcriptDir(worktree, env), runners[agent].transcriptDir(repo, env)];
  if (from === undefined || to === undefined) return false; // #929: an agent with no transcript dir has nothing to move
  if (await isFile(join(to, `${id}.jsonl`))) return true;
  if (!(await isFile(join(from, `${id}.jsonl`)))) return false;
  await mkdir(to, { recursive: true });
  for (const name of [`${id}.jsonl`, id]) await rename(join(from, name), join(to, name)).catch(ignoreMissing);
  return true;
}

// One cwd's transcript of session `id`: <id>.jsonl in its transcript dir, or, for an agent that keeps none per cwd (Codex, #929), the
// session's own file among those its runner lists, always first (#933)
async function transcriptIn(cwd: string, id: string, agent: AgentId, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dir = runners[agent].transcriptDir(cwd, env);
  if (dir === undefined) return (await runners[agent].sessionFiles(cwd, id, env))[0];
  return (await isFile(join(dir, `${id}.jsonl`))) ? join(dir, `${id}.jsonl`) : undefined;
}

/** A session's transcript as its agent's resume finds it from one of `cwds` (#587): the first, in order, that has it. */
export async function findTranscript(cwds: string[], id: string, agent: AgentId, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!isUuid(id)) return undefined;
  for (const cwd of cwds) {
    const found = await transcriptIn(cwd, id, agent, env);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A copy's temporary transcript (#587): <id>.jsonl from the first of `from` that has it into `to`'s transcript dir, where `--resume` looks. Never
 * <id>/ (subagents are not the conversation) and never over a file already there (the link refuses it): that one, or one dir for both, is `same`.
 * An agent with no dir per cwd (Codex) forks the source by id from anywhere (#933): found is `same`, nothing copied. */
export async function copyTranscript(from: string[], to: string, id: string, agent: AgentId, env: NodeJS.ProcessEnv = process.env): Promise<'copied' | 'same' | 'missing'> {
  const dir = runners[agent].transcriptDir(to, env);
  const source = await findTranscript(from, id, agent, env);
  if (source === undefined) return 'missing';
  if (dir === undefined) return 'same';
  const target = join(dir, `${id}.jsonl`);
  if (source === target) return 'same';
  await mkdir(dir, { recursive: true });
  // Copied under a name of its own, then linked in: link fails with EEXIST atomically, so a failure never removes a transcript already there
  const staged = join(dir, `.${id}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    return await link(staged, target).then(() => 'copied' as const, (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return 'same' as const; // not ours: never removed
      throw err;
    });
  } finally {
    await rm(staged, { force: true });
  }
}

/** The temporary <id>.jsonl a copy put in `dir` (#587), once the new session has its own: that file only. Gone already is a debug line. */
export async function dropCopiedTranscript(dir: string, id: string, log: Pick<Logger, 'debug'>): Promise<void> {
  if (!isUuid(id)) return;
  await rm(join(dir, `${id}.jsonl`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    log.debug(`transcript ${id}.jsonl: already gone`);
  });
}
