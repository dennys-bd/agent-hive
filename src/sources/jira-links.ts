import type { Relation } from '../types.js';
import { type BlockingLink, type CategoryOf, stateOf } from './jira-relations.js';

// A Jira issue's relations (#829): its links of every type outside the source's blocking types, which stay the blockers section's. They never
// block. "Issue link" is Jira's word; the Hive's side calls them relations, since the glossary retires "link" as a name for a transition

/** An issue's relations: its links whose type is not a blocking one (compared exactly), in Jira's order, each under the phrase its direction
 * reads. A pair linked by one type in both directions shows twice, once per phrase. Its state follows a blocker's rule (#828). */
export function relationsOf(links: readonly BlockingLink[], blockingTypes: readonly string[], categoryOf: CategoryOf): Relation[] {
  return links.filter((l) => !blockingTypes.includes(l.type)).map((l): Relation => ({
    id: l.key, title: l.title ?? '', state: stateOf(l, categoryOf), type: l.type, direction: l.direction, phrase: l.phrase,
  }));
}
