// The blocker refusals every source type throws (#56), outside src/sources/ since #810: the route and namespaced read them for any type, and
// a second type's adapter imports them without reaching into GitHub's. Words with no source's vocabulary: "issue" is GitHub's
import type { ItemBlockers } from './types.js';

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
/** The relation was written but its re-read failed (#56): the relations ride along when they were read, so the caller can still answer;
 * undefined when even they failed, since empty lists would show the relation just written as gone. */
export class RelationRereadError extends Error {
  constructor(message: string, readonly blockers?: ItemBlockers) { super(message); }
}
