// The hive target of the decomposition's routes (#783): what the preview answers of it and, below, the POST that writes the tree as hive
// tasks. server-decomposition.ts imports this file; it imports only types back, so there is no runtime cycle.
import { isDeepStrictEqual } from 'node:util';
import { taskWorkspace } from './config.js';
import { HIVE_OFF_MESSAGE, ORIGIN_TAKEN_MESSAGE } from './create-task.js';
import { DONE_KEY, PR_KEY, decompositionTarget, fileAddress, recordedIssues, rootBody } from './decomposition.js';
import { checkoutPreview, deliverDecomposition, type Delivery, type DeliveryRead, deliveryRefusal, hiveDeliveryWords, OffGithubError, readDelivery } from './decomposition-deliver.js';
import { entryStage, hiveEntries, type HiveWriteTarget, originTaken, suggestedEntry, writeHiveDecomposition } from './decomposition-write-hive.js';
import type { DecompositionRouteDeps, Goal, Live } from './server-decomposition.js';
import type { Refusal } from './server-tasks.js';
import { HIVE_SOURCE } from './tasks.js';
import { HIVE_EPIC, type Decomposition, type DecompositionHive, type State } from './types.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// decision 4: a hive goal is the root of its own tree; any other goal gets a root task made from it
const isHiveGoal = (goal: Goal): boolean => goal.task.item.source === undefined;

// Decision 5: no checkout, or one off GitHub, keeps the file local under the hive; its path is the one in the checkout off GitHub, else the
// one the result names. Every other refusal is the GitHub target's. Nothing once pr is recorded (read is then undefined)
function hiveDelivery(goal: Goal, read: DeliveryRead | undefined): Pick<DecompositionHive, 'delivery' | 'deliveryRefusal'> {
  if (read === undefined) return {};
  if ('delivery' in read) return checkoutPreview(read.delivery, recordedIssues(goal.result));
  if (read.error instanceof OffGithubError) return { delivery: { path: read.error.path ?? String(goal.result.decomposition), local: true } };
  return { deliveryRefusal: errorMessage(read.error) };
}

/** The preview's hive part (#783, decisions 1 to 5 and 9). */
export function hivePreview(state: State, goal: Goal, read: DeliveryRead | undefined): DecompositionHive {
  const nodes = goal.parsed.decomposition?.nodes;
  const entry = suggestedEntry(state, goal.task);
  return {
    entries: hiveEntries(state.flows), ...(entry === undefined ? {} : { entry }),
    tasks: nodes === undefined ? 0 : nodes.length + (isHiveGoal(goal) ? 0 : 1),
    ...(isHiveGoal(goal) ? { preselected: true as const } : {}),
    ...hiveDelivery(goal, read),
    ...(originTaken(state, goal.task, recordedIssues(goal.result)) ? { refusal: ORIGIN_TAKEN_MESSAGE } : {}),
  };
}

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HIVE_CODE = 'hive'; // decomposition decision 4: the dialog tells a hive failure apart, as it does `transient`
const LOCAL_ITEM = 'local:'; // a hive task's itemId is local:<n>, the number `done` records (decision 11)
const GITHUB_HALFWAY_MESSAGE = 'a decomposição já começou a ser escrita no GitHub: continue por lá'; // decision 6
const ENTRY_MESSAGE = 'entry precisa ser uma das entradas oferecidas'; // decision 7

/** What a hive POST answers (#783): ok, or a refusal; a failure carries the `hive` code. */
export type HiveAnswer = { ok: true } | (Refusal & { code?: string });

// The hive source, decisions 6, 7 and 9, before anything is written: the stage the entry resolves to, or why not
function checkHive(current: Live, goal: Goal, body: unknown): { stage?: string } | Refusal {
  const recorded = recordedIssues(goal.result);
  if (!current.runtime.config.comb.hiveSource) return { status: HTTP_CONFLICT, message: HIVE_OFF_MESSAGE };
  if (decompositionTarget(goal.result) === undefined && Object.keys(recorded).length > 0) return { status: HTTP_CONFLICT, message: GITHUB_HALFWAY_MESSAGE };
  const { entry } = (body ?? {}) as { entry?: unknown };
  const chosen = hiveEntries(current.state.flows).find((offered) => isDeepStrictEqual(offered, entry));
  if (chosen === undefined) return { status: HTTP_BAD_REQUEST, message: ENTRY_MESSAGE };
  if (originTaken(current.state, goal.task, recorded)) return { status: HTTP_CONFLICT, message: ORIGIN_TAKEN_MESSAGE };
  const stage = entryStage(current.state.flows, chosen);
  return stage === undefined ? {} : { stage };
}

// The checkout the file is delivered from; none when it stays local (#741, decision 5) or pr is recorded; or the GitHub target's refusal.
// Any other read error is thrown, to the write's catch
async function shippedOf(deps: DecompositionRouteDeps, goal: Goal, recorded: Readonly<Record<string, number>>): Promise<Delivery | Refusal | undefined> {
  if (recorded[PR_KEY] !== undefined) return undefined;
  const read = await readDelivery(deps.exec, deps.gql, goal.file);
  if ('error' in read) {
    if (read.error instanceof OffGithubError) return undefined;
    throw read.error;
  }
  const refusal = deliveryRefusal(read.delivery.checkout, read.delivery.docs.defaultBranch, recorded);
  if (refusal !== undefined) return { status: HTTP_CONFLICT, message: refusal };
  return read.delivery.checkout.ignored ? undefined : read.delivery;
}

// Decisions 8, 9 and 14: the goal's resolved workspace, a GitHub goal's root task, the Design: links only for a delivered file
function targetOf(current: Live, goal: Goal, d: Decomposition, stage: string | undefined, shipped: Delivery | undefined): HiveWriteTarget {
  const { item } = goal.task;
  const workspace = taskWorkspace(current.runtime.config, goal.task, current.state.tasks)?.name;
  return {
    goal: goal.task, prefix: current.runtime.config.comb.prefix,
    ...(isHiveGoal(goal) ? {} : { root: { title: item.title, body: rootBody(d), url: item.url, origin: item.itemId } }),
    ...(stage === undefined ? {} : { stage }), ...(workspace === undefined ? {} : { workspace }),
    ...(shipped === undefined ? {} : { address: fileAddress(shipped.checkout.repository, shipped.docs.defaultBranch, shipped.checkout.path) }),
  };
}

// Decision 15: the goal by its ref; a goal with no issue link is named by its display id
const refOf = (goal: Goal): string => (isHiveGoal(goal) || goal.number === undefined ? goal.task.item.id : `${goal.repository ?? ''}#${goal.number}`);

// Decision 16: 502 with the hive code; the words go to hive.log
function failed(deps: DecompositionRouteDeps, goal: Goal, message: string): HiveAnswer {
  deps.log.warn(`decomposition #${goal.task.item.id}: the hive write stopped: ${message}`);
  return { status: HTTP_BAD_GATEWAY, message, code: HIVE_CODE };
}

/** The hive write (#783): the checks and the delivery first, then the target recorded, the tree written, the file delivered and `done`
 * recorded with the root's local number; then a hive goal stamped the root epic (before the approve, #556: its approved stage spawns nothing
 * of its own) and every goal approved straight through the reducer, never closed (decisions 11, 13). A refused press records nothing; a
 * failure leaves what was recorded for the next press. */
export async function writeHive(deps: DecompositionRouteDeps, current: Live, goal: Goal, d: Decomposition, activityId: string, body: unknown): Promise<HiveAnswer> {
  const checked = checkHive(current, goal, body);
  if ('status' in checked) return checked;
  const taskId = goal.task.item.itemId;
  const recorded = recordedIssues(goal.result);
  const record = async (id: string, number: number): Promise<void> => { await deps.dispatch({ type: 'decompositionIssue', taskId, id, number }); };
  try {
    const shipped = await shippedOf(deps, goal, recorded);
    if (shipped !== undefined && 'status' in shipped) return shipped;
    // every check has passed, so a refused press never locks the target; still before the first createTask (decision 6)
    if (decompositionTarget(goal.result) === undefined) await deps.dispatch({ type: 'decompositionTarget', taskId, target: HIVE_SOURCE });
    const written = await writeHiveDecomposition({ dispatch: deps.dispatch, latest: deps.latest, record }, d, targetOf(current, goal, d, checked.stage, shipped), recorded);
    if ('error' in written) return failed(deps, goal, written.error);
    const delivered = shipped === undefined ? undefined : await deliverDecomposition({ exec: deps.exec, gql: deps.gql, record }, {
      checkout: shipped.checkout, repositoryId: shipped.docs.id, base: shipped.docs.defaultBranch, ...hiveDeliveryWords(refOf(goal), goal.task.item.title),
    }, recorded);
    if (delivered !== undefined) return failed(deps, goal, delivered);
    await record(DONE_KEY, Number(written.root.slice(LOCAL_ITEM.length)));
    if (isHiveGoal(goal)) await deps.dispatch({ type: 'markEpic', taskId, epic: HIVE_EPIC });
    await deps.dispatch({ type: 'approve', activityId });
    return { ok: true };
  } catch (err) {
    return failed(deps, goal, errorMessage(err));
  }
}
