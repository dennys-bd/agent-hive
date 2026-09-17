import type { BoardCard, Card, Column, Slot, Task } from './types.js';

const SLUG_MAX = 30;

/** A board column the config mentions and the Hive column + field that cites it, for error messages. */
export interface Citation {
  column: string;
  by: string;
}

/** Every board column the config cites, once each, first citation wins: what the adapters validate and list. */
export function citedColumns(columns: Column[]): Citation[] {
  const seen = new Set<string>();
  return columns.flatMap((c) => {
    const mentions: [string, string | undefined][] = [...c.from.map((f): [string, string] => ['from', f]), ['onStart', c.onStart], ['onFinish', c.onFinish]];
    return mentions.flatMap(([field, column]) => {
      if (column === undefined || seen.has(column)) return [];
      seen.add(column);
      return [{ column, by: `${c.name}.${field}` }];
    });
  });
}

function kebab(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugFor(task: Task): string {
  const title = kebab(task.title).slice(0, SLUG_MAX).replace(/-+$/, '');
  return `hive-${kebab(task.id)}-${title}`;
}

/** The only blocking rule: the adapter already filtered the list down to blockers that are still open. */
export function isBlocked(task: Task): boolean {
  return (task.blockedBy?.length ?? 0) > 0;
}

export const cardId = (card: Card): string => card.task.itemId;
export const columnOf = (columns: Column[], name: string): Column | undefined => columns.find((c) => c.name === name);
export const cardOf = (cards: Card[], slot: Slot): Card | undefined => cards.find((c) => c.task.itemId === slot.cardId);

/** The column after `name` in pipeline order; undefined after the last one (or for an unknown name). */
export function nextColumn(columns: Column[], name: string): Column | undefined {
  const index = columns.findIndex((c) => c.name === name);
  return index < 0 ? undefined : columns[index + 1];
}

/** The first Hive column whose `from` names this board column: the only door a card enters (or is moved) through. */
export const entryColumn = (columns: Column[], boardColumn: string): Column | undefined => columns.find((c) => c.from.includes(boardColumn));

// A known card seen again: the task fields refresh, the mark of a card that had gone missing drops, and a human move on the
// board (board column differs from the one the Hive last saw or wrote) follows into the Hive only while the card is stopped.
function seenAgain(card: Card, seen: BoardCard, columns: Column[]): Card {
  if (card.orphan) return card;
  const { missing: _missing, ...rest } = card;
  const entry = seen.column !== card.boardColumn && card.slotId === undefined ? entryColumn(columns, seen.column) : undefined;
  return { ...rest, task: seen.task, boardColumn: seen.column, column: entry?.name ?? card.column };
}

const entered = (seen: BoardCard, columns: Column[]): Card[] => {
  const entry = entryColumn(columns, seen.column);
  return entry ? [{ task: seen.task, column: entry.name, boardColumn: seen.column, slug: slugFor(seen.task) }] : [];
};

const unlisted = (card: Card): Card => (card.orphan || card.missing ? card : { ...card, missing: true });

/** The poll: listed cards in board order (known ones updated, unknown ones entered through a `from`), unlisted ones kept at their index and marked missing. */
export function mergeCards(cards: Card[], columns: Column[], listed: BoardCard[]): Card[] {
  const known = new Map(cards.map((c) => [cardId(c), c]));
  const listedIds = new Set(listed.map((c) => c.task.itemId));
  const fromBoard = listed.flatMap((seen) => {
    const card = known.get(seen.task.itemId);
    return card ? [seenAgain(card, seen, columns)] : entered(seen, columns);
  });
  return cards.reduce<Card[]>((result, card, i) =>
    (listedIds.has(cardId(card)) ? result : [...result.slice(0, i), unlisted(card), ...result.slice(i)]), fromBoard);
}

/** Cards a free slot may take, best first: stopped, present on the board, unblocked, in a column with a prompt; higher weight wins, ties keep board order. */
export function candidates(cards: Card[], columns: Column[]): Card[] {
  const weight = (card: Card): number => columnOf(columns, card.column)?.weight ?? 0;
  const runnable = cards.filter((c) => c.slotId === undefined && !c.missing && !isBlocked(c.task) && columnOf(columns, c.column)?.prompt !== undefined);
  return [...runnable].sort((a, b) => weight(b) - weight(a)); // sort is stable: equal weights keep the listing order
}
