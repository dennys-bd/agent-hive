// The user's protocol passages (#336). No node imports, so the protocol screen's preview (#337) runs the same code.
import { isProtocolBlockId, PROTOCOL_BLOCKS } from './protocol.js';
import { liquidSyntaxError, type ParsedTemplate, parseTemplate, renderTemplate, splitHeader, type TemplateError } from './template.js';

export interface Passage { id: string; text: string } // text: the whole file, header included
export interface RenderedPassage { id: string; after: string; orphan: boolean; text?: string; errors: TemplateError[] } // text absent on an error

const HEADER_KEYS = ['after', 'variables'];
const HEADER_FIRST_LINE = 2; // right under the opening fence, as template.ts counts
export const AFTER_MESSAGE = `after must be one of: ${PROTOCOL_BLOCKS.join(', ')}`;
export const headerKeyMessage = (key: string): string => `unknown header key "${key}" (known: ${HEADER_KEYS.join(', ')})`;

// The header line a top-level key is written on, or the header's first: parseTemplate keeps no position for a key it does not read
function keyLine(text: string, key: string): number {
  const headerLines = text.split('\n').slice(0, splitHeader(text).bodyLine - 1);
  const index = headerLines.findIndex((line) => line.startsWith(`${key}:`));
  return index < 0 ? HEADER_FIRST_LINE : index + 1;
}

/** Why a passage cannot be saved (#336), [] when it can: the header first (parseTemplate checks the variables), then the keys a passage may
 * have, its anchor, and the Liquid, which parseTemplate does not parse. */
export function passageErrors(text: string): TemplateError[] {
  const parsed = parseTemplate(text);
  if (parsed.errors.length > 0) return parsed.errors;
  const keys = Object.keys(parsed.header).filter((key) => !HEADER_KEYS.includes(key)).map((key) => ({ line: keyLine(text, key), message: headerKeyMessage(key) }));
  const { after } = parsed.header;
  const anchor = typeof after === 'string' && isProtocolBlockId(after) ? [] : [{ line: keyLine(text, 'after'), message: AFTER_MESSAGE }];
  const liquid = liquidSyntaxError(parsed);
  return [...keys, ...anchor, ...(liquid === undefined ? [] : [liquid])];
}

// An anchor a Hive update removed is kept: the passage goes last and the routes say orphan
const anchorOf = (parsed: ParsedTemplate): { after: string; orphan: boolean } => {
  const after = typeof parsed.header.after === 'string' ? parsed.header.after : '';
  return { after, orphan: !isProtocolBlockId(after) };
};
export const passageAnchor = (text: string): { after: string; orphan: boolean } => anchorOf(parseTemplate(text));

const trimBlankLines = (text: string): string => text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');

/** Each passage rendered for `workspace` (#336), in the order given: the workspace built-in and its own variables through template.lang.
 * renderTemplate answers the delivered header (after:) with the body, or the whole source when there is nothing to render; only the body is
 * the user's text. A failure answers its errors and no text, for this workspace alone. */
export function renderPassages(passages: readonly Passage[], workspace: string): RenderedPassage[] {
  return passages.map(({ id, text }) => {
    const parsed = parseTemplate(text);
    const result = renderTemplate(parsed, workspace);
    return result.ok
      ? { id, ...anchorOf(parsed), text: trimBlankLines(splitHeader(result.text).body), errors: [] }
      : { id, ...anchorOf(parsed), errors: result.errors };
  });
}
