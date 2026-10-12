import type { Express, Request, Response } from 'express';
import { copyNotice, type CopySide, noticeSide, readBranch, sourceSide, targetSide, uncommitted } from './copy-sides.js';
import { activityParam, keptTarget } from './activity-routes.js';
import { copyPending } from './local-sessions.js';
import { answerOpen, type TaskRouteDeps, type Refusal } from './server-tasks.js';
import { COPY_PENDING_MESSAGE } from './server-sessions.js';
import { copyTranscript, dropCopiedTranscript, findTranscript } from './transcript.js';
import { sizeIn, type TerminalSize } from './terminal-wire.js';
import type { Session, CopySummary, Exec, SessionRef, SessionTarget } from './types.js';
import { countMessages, transcriptDir } from './agents/claude-transcript.js'; // temporary (#924): Task 7 reads the session's runner
import { cleanTitle } from './usage.js';

type Deps = Pick<TaskRouteDeps, 'requireLive' | 'dispatch' | 'started' | 'exec' | 'log'>;
interface Planned { from: SessionRef; to: SessionTarget; source: CopySide; target: CopySide; session: Session }

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const BAD_TARGET = 'destino inválido';
const TARGET_GONE = 'o destino não aceita mais a cópia'; // the reducer refused: the target changed while the copy ran
const READ_FAILED = 'o histórico desta sessão não pôde ser lido';
const COPY_FAILED = 'o histórico desta sessão não pôde ser copiado';
const NO_TRANSCRIPT = 'O histórico desta sessão não existe mais'; // #208's words

const refuse = (res: Response, { status, message }: Refusal): void => { res.status(status).json({ error: message }); };
// A filesystem failure (#587): the dialog shows the words, the log the reason
const errCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : 'error');
function failed(deps: Deps, res: Response, message: string, err: unknown): void {
  deps.log.error(`copy: ${message}: ${errCode(err)}`); // the code only: an fs message carries the home path
  refuse(res, { status: HTTP_SERVER_ERROR, message });
}
const refOf = (req: Request): SessionRef => ({ activityId: activityParam(req), sessionId: String(req.params.session) });
// A live activity's id (#587, #629): a task's or a workspace's local one
const targetOf = (raw: unknown): SessionTarget | undefined => (typeof raw === 'string' ? { activityId: raw } : undefined);
// The source's record first (#629): an unknown :id answers 404 before the body is read
const unknownSource = (current: NonNullable<ReturnType<Deps['requireLive']>>, req: Request): Refusal | undefined => {
  const kept = keptTarget(current.state, activityParam(req));
  return 'status' in kept ? kept : undefined;
};

function plan(current: NonNullable<ReturnType<Deps['requireLive']>>, from: SessionRef, to: SessionTarget): Planned | Refusal {
  const found = sourceSide(current.state, current.runtime.config, from);
  if ('status' in found) return found;
  const target = targetSide(current.state, current.runtime.config, to, from);
  if ('status' in target) return target;
  if (copyPending(current.state.workers, from.sessionId, transcriptDir(target.cwd))) return { status: HTTP_CONFLICT, message: COPY_PENDING_MESSAGE };
  return { from, to, source: found.side, target, session: found.session };
}

async function summarize({ source, target, session }: Planned, exec: Exec): Promise<CopySummary | undefined> {
  const transcript = await findTranscript(source.transcriptCwds, session.id);
  if (transcript === undefined) return undefined;
  const [fromBranch, toBranch, changes, messages] = await Promise.all([
    source.onDisk ? readBranch(source.cwd, exec) : null, readBranch(target.cwd, exec),
    source.onDisk ? uncommitted(source.cwd, exec) : 0, countMessages(transcript),
  ]);
  return { from: { path: source.cwd, branch: fromBranch }, to: { path: target.cwd, branch: toBranch }, messages, tokens: session.tokens ?? 0, uncommitted: changes };
}

async function noticeFor({ source, target }: Planned, exec: Exec): Promise<string> {
  const [fromBranch, toBranch] = await Promise.all([source.onDisk ? readBranch(source.cwd, exec) : null, readBranch(target.cwd, exec)]);
  return copyNotice(noticeSide(source, fromBranch), noticeSide(target, toBranch));
}

// The copy (#587): the transcript where --resume looks, then the dispatch; a dispatch the reducer refused (a race) leaves no stray copy
async function runCopy(deps: Deps, planned: Planned, body: { name?: unknown; notice: boolean; size?: TerminalSize }, res: Response): Promise<void> {
  let copied: Awaited<ReturnType<typeof copyTranscript>>;
  try {
    copied = await copyTranscript(planned.source.transcriptCwds, planned.target.cwd, planned.session.id);
  } catch (err) {
    return failed(deps, res, COPY_FAILED, err);
  }
  if (copied === 'missing') return refuse(res, { status: HTTP_CONFLICT, message: NO_TRANSCRIPT });
  const dir = transcriptDir(planned.target.cwd);
  const name = cleanTitle(body.name);
  const notice = body.notice ? await noticeFor(planned, deps.exec) : undefined;
  const effects = await deps.dispatch({
    type: 'copySession', from: planned.from, to: planned.to,
    ...(name === undefined ? {} : { name }), ...(notice === undefined ? {} : { notice }), ...(copied === 'copied' ? { copied: dir } : {}),
  }, body.size); // #808: the grid of the copy's session
  if (effects.some((e) => e.type === 'spawnSession')) return answerOpen(deps, effects, res);
  if (copied === 'copied') await dropCopiedTranscript(dir, planned.session.id, deps.log);
  refuse(res, { status: HTTP_CONFLICT, message: TARGET_GONE });
}

/** Copy (#587): GET answers the dialog's summary, POST copies. Any record's session as the source, a task's, a deleted activity's or a
 * workspace's local one (#629); a live activity as the target. */
export function registerCopyRoutes(app: Express, deps: Deps): void {
  app.get('/activities/:id/sessions/:session/copy', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const unknown = unknownSource(current, req);
    if (unknown) return refuse(res, unknown);
    const to = targetOf(req.query.toActivity);
    if (!to) return refuse(res, { status: HTTP_BAD_REQUEST, message: BAD_TARGET });
    const planned = plan(current, refOf(req), to);
    if ('status' in planned) return refuse(res, planned);
    let summary: CopySummary | undefined;
    try {
      summary = await summarize(planned, deps.exec);
    } catch (err) {
      return failed(deps, res, READ_FAILED, err);
    }
    if (!summary) return refuse(res, { status: HTTP_CONFLICT, message: NO_TRANSCRIPT });
    res.json(summary);
  });
  app.post('/activities/:id/sessions/:session/copy', async (req: Request, res: Response) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const unknown = unknownSource(current, req);
    if (unknown) return refuse(res, unknown);
    const { to: raw, name, notice } = (req.body ?? {}) as { to?: { activityId?: unknown }; name?: unknown; notice?: unknown };
    const to = raw && typeof raw === 'object' ? targetOf(raw.activityId) : undefined;
    if (!to || typeof notice !== 'boolean' || (name !== undefined && typeof name !== 'string')) return refuse(res, { status: HTTP_BAD_REQUEST, message: BAD_TARGET });
    const planned = plan(current, refOf(req), to);
    if ('status' in planned) return refuse(res, planned);
    await runCopy(deps, planned, { name, notice, size: sizeIn(req.body) }, res);
  });
}
