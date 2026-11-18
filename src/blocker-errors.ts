// The blocker refusals every source type throws (#56), outside src/sources/ since #810: the route and namespaced read them for any type, and
// a second type's adapter imports them without reaching into GitHub's. Their words name no source's vocabulary, since "issue" is GitHub's
import type { ItemBlockers, Relation } from './types.js';

/** A ref the item's source type does not read (#810 decision 7): the adapter knows its type's forms and the route does not, so the sentence
 * is built here from the grammar's `forms` and the route answers it as it is. */
export class BadBlockerRefError extends Error {
  constructor(ref: string, forms: string) { super(`"${ref}" is no ref: write ${forms} or a task id`); }
}
/** Nothing on the source answers the ref (#56). */
export class BlockerRefNotFoundError extends Error {
  constructor(ref: string) { super(`nothing answers ${ref}`); }
}
/** The ref is the item itself (#56). */
export class SelfBlockerError extends Error {
  constructor() { super('an item cannot block itself'); }
}
/** A relation change that names a blocking type (#829): those links are the blockers section's, so each link shows in one place only. */
export class BadRelationTypeError extends Error {
  constructor(type: string) { super(`"${type}" is a blocking link type: the blockers section edits it`); }
}
/** The relation was written but its re-read failed (#56): the relations ride along when they were read, so the caller can still answer;
 * undefined when even they failed, since empty lists would show the relation just written as gone. Relations (#829): the relations a relation
 * write read before its re-read failed. */
export class RelationRereadError extends Error {
  constructor(message: string, readonly blockers?: ItemBlockers, readonly relations?: Relation[]) { super(message); }
}
