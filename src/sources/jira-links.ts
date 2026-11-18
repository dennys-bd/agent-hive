import { BadRelationTypeError, RelationRereadError } from '../blocker-errors.js';
import type { Relation, RelationChange, RelationWrite } from '../types.js';
import { linksOf } from './jira-item.js';
import { deleteIssueLink, postIssueLink, readIssue } from './jira-queries.js';
import { afterWrite, type BlockingLink, type CategoryOf, checkedOtherId, endsOf, otherOf, type RelationsContext, stateOf } from './jira-relations.js';

// A Jira issue's relations (#829): its links of every type outside the source's blocking types, which stay the blockers section's. They never
// block. "Issue link" is Jira's word; the Hive's side calls them relations, since the glossary retires "link" as a name for a transition

/** An issue's relations: its links whose type is not a blocking one (compared exactly), in Jira's order, each under the phrase its direction
 * reads. A pair linked by one type in both directions shows twice, once per phrase. Its state follows a blocker's rule (#828). */
export function relationsOf(links: readonly BlockingLink[], blockingTypes: readonly string[], categoryOf: CategoryOf): Relation[] {
  return links.filter((l) => !blockingTypes.includes(l.type)).map((l): Relation => ({
    id: l.key, title: l.title ?? '', state: stateOf(l, categoryOf), type: l.type, direction: l.direction, phrase: l.phrase,
  }));
}

const relationsRead = (ctx: RelationsContext, links: readonly BlockingLink[]): Relation[] =>
  relationsOf(links, ctx.blockingTypes, ctx.categories(links.map((l) => l.id)));

/** One relation added or removed on a Jira issue (#829), under relate's contract (#828): a blocking type is refused before any call, the
 * issue and the ref are read live, and a change that already holds sends nothing and answers the relations read, so a double click is
 * harmless. A removal deletes every link of that type and direction to the other issue. A type the site lacks is Jira's refusal. */
export async function setRelation(ctx: RelationsContext, itemId: string, change: RelationChange): Promise<RelationWrite> {
  if (ctx.blockingTypes.includes(change.type)) throw new BadRelationTypeError(change.type);
  const own = await readIssue(ctx.call, itemId);
  const other = await otherOf(ctx, change.ref);
  const otherId = checkedOtherId(own, other);
  const links = linksOf(own.issue);
  const matches = links.filter((l) => l.id === otherId && l.type === change.type && l.direction === change.direction);
  if ((matches.length > 0) === (change.action === 'add')) return { relations: relationsRead(ctx, links) };
  if (change.action === 'add') {
    await postIssueLink(ctx.call, change.type, ...endsOf(change.direction, own, other));
  } else {
    for (const link of matches) await deleteIssueLink(ctx.call, link.linkId); // in turn: a retry deletes whatever a failure left
  }
  const { value, entry } = await afterWrite(ctx, itemId, (l) => relationsRead(ctx, l), (message, relations) => new RelationRereadError(message, undefined, relations));
  return { relations: value, ...(entry === undefined ? {} : { entry }) };
}
