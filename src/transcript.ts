import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './log.js';
import { isUuid } from './orchestrator.js';
import type { Session } from './types.js';
import { transcriptDir } from './agents/claude-transcript.js'; // temporary (#924): Task 7 reads the session's runner

// <id>.jsonl and <id>/ in `dir`: a file already gone is a debug line, any other failure rejects
async function removeIn(dir: string, id: string, log: Pick<Logger, 'debug'>): Promise<void> {
  for (const name of [`${id}.jsonl`, id]) {
    await rm(join(dir, name), { recursive: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      log.debug(`transcript ${name}: already gone`);
    });
  }
}

/**
 * Deletes the transcripts of `sessions` (#236): `<id>.jsonl` and the `<id>/` directory (its subagents' transcripts) in the transcript dir of
 * `worktree`, the path Claude Code encodes from the cwd it ran in; a `repo` session (#208) in the main repo's too, where its first open moved
 * it. Nothing else there goes: never the directory itself, never memory/. An id that is not a uuid is skipped: the Hive's own sessions are
 * uuids, and anything looser could name another entry there.
 */
export async function removeTranscripts(
  worktree: string, repo: string, sessions: Pick<Session, 'id' | 'repo'>[], log: Pick<Logger, 'debug'>, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const [own, main] = [transcriptDir(worktree, env), transcriptDir(repo, env)];
  for (const { id, repo: moved } of sessions.filter((s) => isUuid(s.id))) {
    for (const dir of moved ? [own, main] : [own]) await removeIn(dir, id, log);
  }
}

const isFile = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);
const ignoreMissing = (err: NodeJS.ErrnoException): void => {
  if (err.code !== 'ENOENT') throw err;
};

/** A `repo` session's transcript, where `claude --resume` looks from the main repo (#208): it only looks in the dir of its cwd. Moved one way,
 * the first time the session opens, `<id>/` too when it has one; never copied, so there is one transcript. True when it is in the main repo's
 * dir now, false when neither dir has it or the id is not a session id. */
export async function adoptTranscript(worktree: string, repo: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [from, to] = [transcriptDir(worktree, env), transcriptDir(repo, env)];
  if (await isFile(join(to, `${id}.jsonl`))) return true;
  if (!(await isFile(join(from, `${id}.jsonl`)))) return false;
  await mkdir(to, { recursive: true });
  for (const name of [`${id}.jsonl`, id]) await rename(join(from, name), join(to, name)).catch(ignoreMissing);
  return true;
}

/** A session's transcript as `claude --resume` finds it from one of `cwds` (#587): the first dir, in order, holding <id>.jsonl as a file. */
export async function findTranscript(cwds: string[], id: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!isUuid(id)) return undefined;
  for (const cwd of cwds) {
    const path = join(transcriptDir(cwd, env), `${id}.jsonl`);
    if (await isFile(path)) return path;
  }
  return undefined;
}

/** A copy's temporary transcript (#587): <id>.jsonl from the first of `from` that has it into `to`'s transcript dir, where `--resume` looks. Never
 * <id>/ (subagents are not the conversation) and never over a file already there (the link refuses it): that one, or one dir for both, is `same`. */
export async function copyTranscript(from: string[], to: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<'copied' | 'same' | 'missing'> {
  const source = await findTranscript(from, id, env);
  if (source === undefined) return 'missing';
  const dir = transcriptDir(to, env);
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
