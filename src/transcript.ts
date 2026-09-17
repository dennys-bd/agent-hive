import { open, stat } from 'node:fs/promises';

export const OUTPUT_LINES = 200;
export const TAIL_BYTES = 256 * 1024; // more than OUTPUT_LINES of any session; a transcript can be tens of MB and is read on every poll
export const DIFF_MAX = 40; // lines shown per side of an Edit; the panel is a glance, not a review
export const DIFF_LINE_MAX = 200; // chars per diff line: a minified blob must not become one unbounded panel entry
const CUT_MARK = '…';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TranscriptLine {
  type?: string;
  message?: { content?: ContentBlock[] };
}

// One JSON object per line. Anything else is not a line.
function parseLine(line: string): TranscriptLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TranscriptLine) : undefined;
  } catch {
    return undefined;
  }
}

// One side of the Edit: every line prefixed and cut at DIFF_LINE_MAX, the side cut at DIFF_MAX with a mark; an empty
// side (a pure insertion) adds nothing. CRLF is normalised so no `\r` reaches the panel.
function diffSide(sign: '-' | '+', text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const shown = lines.slice(0, DIFF_MAX).map((line) => `${sign}${line.slice(0, DIFF_LINE_MAX)}`);
  return lines.length > DIFF_MAX ? [...shown, CUT_MARK] : shown;
}

// The only place in the transcript where a diff exists: tool results are dropped and a Write can be huge. The whole block
// is one entry (like an assistant text block), so a cut at `max` lines never splits a fence and leaves a stray closing marker.
function describeEdit(input: Record<string, unknown>): string[] {
  const block = [
    '```diff',
    ...diffSide('-', String(input.old_string ?? '')),
    ...diffSide('+', String(input.new_string ?? '')),
    '```',
  ];
  return [`▶ Edit: ${String(input.file_path ?? '').slice(0, TOOL_MAX)}`, block.join('\n')];
}

function describeBlock(block: ContentBlock): string[] {
  if (block.type === 'text') return block.text ? [block.text.slice(0, TEXT_MAX)] : [];
  if (block.type !== 'tool_use') return [];
  const input = block.input ?? {};
  if (block.name === 'Edit') return describeEdit(input);
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? '').slice(0, TOOL_MAX);
  const name = block.name ?? 'tool';
  return [detail ? `▶ ${name}: ${detail}` : `▶ ${name}`];
}

/** What one transcript line becomes in the panel: assistant text and tool calls; nothing for the rest. */
export function formatOutput(line: string): string[] {
  const parsed = parseLine(line);
  if (parsed?.type !== 'assistant') return [];
  return (parsed.message?.content ?? []).flatMap(describeBlock);
}

/** The last `max` formatted lines of a transcript, read from its tail only: no state, nothing kept between calls. */
export async function tailTranscript(path: string, max = OUTPUT_LINES): Promise<string[]> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`não é um arquivo regular: ${path}`);
  const start = Math.max(0, info.size - TAIL_BYTES);
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return (start > 0 ? lines.slice(1) : lines).flatMap(formatOutput).slice(-max); // a read from mid-file starts inside a line
  } finally {
    await file.close();
  }
}
