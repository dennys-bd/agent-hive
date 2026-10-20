// The Project's item pages (#756, #282): what the poll, the filter options and the native view read with. Its own file so github.ts stays under 400 lines
import type { Gql, SourceQuota } from '../types.js';
import { PAGE_SIZE, type GhItemNode, type GhProjectField, type GhRateLimit, type ItemsData } from './github-queries.js';

/** Ten pages (#756): 1000 keeps one load bounded; past it the view says truncated, and the poll warns (#282). */
export const PROJECT_ITEM_LIMIT = 1000;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// The reading taken after a poll, from a field the poll already paid for, and after every repository read (#757). Any other shape → undefined.
export function quotaFrom(rate: GhRateLimit | null | undefined): SourceQuota | undefined {
  const { limit, remaining, resetAt } = rate ?? {};
  if (!isCount(limit) || !isCount(remaining) || typeof resetAt !== 'string') return undefined;
  return { limit, remaining, resetsAt: resetAt, at: new Date().toISOString() };
}

/** What pageItems read (#756): the nodes, the first page's rateLimit and project fields, and whether items were left past the limit. */
export interface ItemPages { nodes: GhItemNode[]; rateLimit?: GhRateLimit | null; fields: GhProjectField[]; truncated: boolean }

// Raw GraphQL caps `items` at 100 per page: up to `limit` items, PROJECT_ITEM_LIMIT for the poll, the filter options and
// the native view (#282). The first page's rateLimit is the reading a poll takes its quota from; its fields, what the native view asks.
export async function pageItems(gql: Gql, query: string, variables: Record<string, string | number>, notFound: string, limit: number): Promise<ItemPages> {
  const nodes: GhItemNode[] = [];
  let first: ItemsData | undefined;
  let after: string | undefined;
  for (let pageIndex = 0; pageIndex < limit / PAGE_SIZE; pageIndex++) {
    const data = (await gql(query, { ...variables, ...(after === undefined ? {} : { after }) })) as ItemsData;
    first ??= data;
    const items = data.repositoryOwner?.projectV2?.items;
    if (!items) throw new Error(notFound);
    nodes.push(...items.nodes);
    after = items.pageInfo.hasNextPage && items.pageInfo.endCursor ? items.pageInfo.endCursor : undefined;
    if (after === undefined) break;
  }
  return { nodes, rateLimit: first?.rateLimit, fields: first?.repositoryOwner?.projectV2?.fields?.nodes ?? [], truncated: after !== undefined };
}
