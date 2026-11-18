// A decomposition written into its goal's own source (#832): a Jira goal's tree as issues of its project, through the source's calls only
// (createDepth, comment, create, relate), so every new issue is re-read and stored by the adapter and reaches the read model with no sync.
// The GitHub write (decomposition-write.ts) keeps its GraphQL. Each issue is recorded through `record` as soon as the source made it, so a
// retry creates none twice; the blockers are replayed, and a link the source already holds is done (relate reads before it writes).
import { DESIGN_KEY, designComment, designLink, issueBody } from './decomposition.js';
import { parentOf } from './decomposition-check.js';
import type { Refusal } from './server-tasks.js';
import { CreateRefusedError } from './source-create.js';
import type { Decomposition, DecompositionNode, Source } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

/** The source calls the write goes through (#832); item only reads the key of an issue an earlier press made. */
export type WriteSource = Required<Pick<Source, 'create' | 'relate' | 'comment' | 'createDepth'>> & Pick<Source, 'item'>;
export const isWritable = (source: Source | undefined): source is Source & WriteSource =>
  source?.create !== undefined && source.relate !== undefined && source.comment !== undefined && source.createDepth !== undefined;

/** The goal (#832): its namespaced itemId (`tickets:10001`) and the key its issues name as their parent (`ABC-1`). */
export interface SourceGoal { itemId: string; key: string }
export interface SourceWriteTarget { goal: SourceGoal; column: string; address?: string } // address: fileAddress; absent, no Design: link (#741)
export interface SourceWriteDeps { source: WriteSource; record(id: string, number: number): Promise<void> }
/** The goal's numeric id once every step is done, else what was done and the source's words: 400 for a refusal, 502 otherwise. */
export type SourceOutcome = { root: number } | { error: string; status: number };

export const NO_BLOCKING_TYPE_MESSAGE = 'the source has no blocking link type: the file\'s "Blocked by" lines cannot be written';
export const tooDeepMessage = (node: string, key: string, depth: number): string =>
  `node ${node} is too deep for ${key}: it takes ${depth} level${depth === 1 ? '' : 's'} of issues under it`;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const levelOf = (id: string): number => id.split('.').length; // "1" is the first level under the goal, "1.2" the second
const prefixOf = (itemId: string): string => itemId.slice(0, itemId.indexOf(':') + 1);

/** What a step records (#832): the adapter's id after the source's name; Jira ids are integers, so recordedIssues keeps them. */
export function numberOf(itemId: string): number {
  const number = Number(itemId.slice(itemId.indexOf(':') + 1));
  if (!Number.isSafeInteger(number)) throw new Error(`${itemId} has no numeric id to record`);
  return number;
}

/** The key an issue's URL ends in (#832: Jira's /browse/<key>); undefined for a URL with none. */
export function keyOfUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const last = new URL(url).pathname.split('/').at(-1);
  return last === undefined || last === '' ? undefined : decodeURIComponent(last);
}

/** The checks before anything is written (#832): blockers on a source with no blocking type, a goal above the epic (createDepth's refusal),
 * and the first node deeper than the goal takes. Each is a 409, so a file is never half-written over a setting or a level. */
export async function sourceRefusal(source: Pick<WriteSource, 'createDepth'>, d: Decomposition, goal: SourceGoal, hasBlockingType: boolean): Promise<Refusal | undefined> {
  if (!hasBlockingType && d.nodes.some((n) => n.blockedBy.length > 0)) return { status: HTTP_CONFLICT, message: NO_BLOCKING_TYPE_MESSAGE };
  const depth = await source.createDepth(goal.itemId).catch((err: unknown) => {
    if (err instanceof CreateRefusedError) return err;
    throw err;
  });
  if (depth instanceof CreateRefusedError) return { status: HTTP_CONFLICT, message: depth.message };
  const deep = d.nodes.find((n) => levelOf(n.id) > depth);
  return deep === undefined ? undefined : { status: HTTP_CONFLICT, message: tooDeepMessage(deep.id, goal.key, depth) };
}

interface Ctx extends SourceWriteDeps {
  d: Decomposition; target: SourceWriteTarget; recorded: Readonly<Record<string, number>>;
  ids: Map<string, string>; keys: Map<string, string>; // node id → itemId; itemId → key
}

function idOf(ctx: Ctx, nodeId: string): string {
  if (nodeId === '') return ctx.target.goal.itemId;
  const id = ctx.ids.get(nodeId);
  if (id === undefined) throw new Error(`no issue for node ${nodeId}`); // the parser refuses a node before its parent or blocker
  return id;
}

// The key a body or a blocker names: known for the goal and for what this press made; read once from the source for what an earlier press made
async function keyOf(ctx: Ctx, itemId: string): Promise<string> {
  const known = ctx.keys.get(itemId);
  if (known !== undefined) return known;
  const read = await ctx.source.item(itemId, '');
  const url = 'entry' in read ? read.entry.item.url : 'item' in read ? read.item.url : undefined;
  const key = url === undefined ? undefined : keyOfUrl(url);
  if (key === undefined) throw new Error(`${itemId} is gone from the source`);
  ctx.keys.set(itemId, key);
  return key;
}

// The goal's design, posted once as a comment and never edited into its description, as on GitHub
async function postDesign(ctx: Ctx): Promise<void> {
  const { d, target, recorded } = ctx;
  if (d.design === undefined || recorded[DESIGN_KEY] !== undefined) return;
  await ctx.source.comment(target.goal.itemId, designComment(d));
  await ctx.record(DESIGN_KEY, numberOf(target.goal.itemId));
}

// One node's issue under its parent's, typed by the adapter from the parent's level (no issueType is sent). ponytail: a crash between the
// source's answer and the record leaves one duplicate, as on GitHub
async function ensure(ctx: Ctx, node: DecompositionNode): Promise<void> {
  const number = ctx.recorded[node.id];
  if (number !== undefined) {
    ctx.ids.set(node.id, `${prefixOf(ctx.target.goal.itemId)}${number}`);
    return;
  }
  const parent = idOf(ctx, parentOf(node.id));
  const { address, column } = ctx.target;
  const links = { parent: await keyOf(ctx, parent), ...(address === undefined ? {} : { design: designLink(ctx.d, node, address) }) };
  const labels = ctx.d.label === undefined ? [] : [ctx.d.label];
  const made = await ctx.source.create({ title: node.title, body: issueBody(node, links), column, labels, parent });
  if (made.itemId === undefined) throw new Error(`the source answered no item for "${node.title}"`);
  await ctx.record(node.id, numberOf(made.itemId));
  ctx.ids.set(node.id, made.itemId);
  ctx.keys.set(made.itemId, made.ref.id);
}

// One add per Blocked by, in file order, after every issue exists: relate takes the source's first blocking type and its direction
async function relateAll(ctx: Ctx): Promise<void> {
  for (const node of ctx.d.nodes) {
    for (const blocker of node.blockedBy) {
      await ctx.source.relate(idOf(ctx, node.id), { action: 'add', kind: 'blockedBy', ref: await keyOf(ctx, idOf(ctx, blocker)) });
    }
  }
}

/** The write (#832), skipping the keys `recorded` holds: the design comment, every node's issue in file order, then the blockers. Run after
 * sourceRefusal. What was done stays recorded, so a second press resumes. */
export async function writeSourceDecomposition(deps: SourceWriteDeps, d: Decomposition, target: SourceWriteTarget, recorded: Readonly<Record<string, number>>): Promise<SourceOutcome> {
  const ctx: Ctx = { ...deps, d, target, recorded, ids: new Map(), keys: new Map([[target.goal.itemId, target.goal.key]]) };
  try {
    await postDesign(ctx);
    for (const node of d.nodes) await ensure(ctx, node);
    await relateAll(ctx);
    return { root: numberOf(target.goal.itemId) };
  } catch (err) {
    const status = err instanceof CreateRefusedError ? HTTP_BAD_REQUEST : HTTP_BAD_GATEWAY;
    return { error: `created ${ctx.ids.size} of ${d.nodes.length} issues; ${messageOf(err)}`, status };
  }
}
