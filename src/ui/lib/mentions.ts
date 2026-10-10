// `@` mentions in a comment or reply field (#591). Pure. A chip is a word of the field's text, so it flows and wraps like one; the field
// also keeps the ids its chips name, and the message keeps its chips in its text (#591).
// The chip's text is shared with the server, which reads the stored text's chips as the sessions' names
export { CHIP_ID_CHARS, chipId, chipText } from '../../review-message.js';

export interface MentionQuery { start: number; query: string } // start: the @'s index

const QUERY = /(^|\s)@([^\s@]*)$/;

/** The @word the caret ends, when it starts the text or follows a space. */
export function mentionAt(text: string, caret: number): MentionQuery | undefined {
  const found = QUERY.exec(text.slice(0, caret));
  return found === null ? undefined : { start: caret - found[2].length - 1, query: found[2] };
}

export const stripMention = (text: string, at: MentionQuery, caret: number): string => text.slice(0, at.start) + text.slice(caret);

export const withChip = (chips: readonly string[], id: string): string[] => (chips.includes(id) ? [...chips] : [...chips, id]);

export interface ChipText { id: string; text: string }
export interface Segment { text: string; chip?: string } // chip: the id of the session this run of text is the chip of

/** The text as plain runs and chips, in order: what the backdrop draws. */
export function segmentsOf(text: string, chips: readonly ChipText[]): Segment[] {
  const next = chips.map((c) => ({ at: text.indexOf(c.text), chip: c })).filter((f) => f.at !== -1).sort((a, b) => a.at - b.at)[0];
  if (next === undefined) return text === '' ? [] : [{ text }];
  const before = text.slice(0, next.at);
  const rest = segmentsOf(text.slice(next.at + next.chip.text.length), chips);
  return [...(before === '' ? [] : [{ text: before }]), { text: next.chip.text, chip: next.chip.id }, ...rest];
}

export const matchesQuery = (label: string, query: string): boolean => label.toLowerCase().includes(query.toLowerCase());
