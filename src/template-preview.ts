// The "view as" preview of a template (#319, node 3.5 of #309): every body line rendered for one workspace, each marker and each line of a
// branch that does not hold flagged, checked against the render. Node-free, beside template.ts and template-map.ts: the editor runs it
// whenever the buffer or the "view as" workspace changes.
import type { MapBlock, MapBranch, TemplateMap } from './template-map.js';
import { deliveredHeader, type ParsedTemplate, renderFragment, renderTemplate, type TemplateError } from './template.js';

export interface PreviewLine { text: string; holds: boolean; isMarker: boolean; line: number } // line: the source line, 1-based
export type Preview = { ok: true; header: string; lines: PreviewLine[]; isExact: boolean } | { ok: false; errors: TemplateError[] };
export type ChainBlock = Extract<MapBlock, { kind: 'chain' }>;

// A branch's lines, its marker first: the \n after a marker belongs to the branch it opens, so the marker's empty line stays only when the
// branch does; an end marker is outside every branch of its chain
interface Span { from: number; to: number; holds: boolean }

/** Every chain of the map, nested ones too, outer first (the editor's marks read them too). */
export function chainsOf(blocks: readonly MapBlock[]): ChainBlock[] {
  return blocks.flatMap((block): ChainBlock[] => {
    if (block.kind === 'heading') return chainsOf(block.children);
    if (block.kind !== 'chain') return [];
    return [block, ...block.branches.flatMap((branch) => chainsOf(branch.children))];
  });
}

// Liquid itself says whether a condition holds: the render's engine, context and operators, so no second reading of a condition can drift
function conditionHolds(parsed: ParsedTemplate, workspace: string, branch: MapBranch): boolean {
  const tag = branch.marker === 'unless' ? 'unless' : 'if';
  return renderFragment(parsed, workspace, `{% ${tag} ${branch.conditionText} %}1{% end${tag} %}`) === '1';
}

// The first branch whose condition holds, else the else; -1 for none. A condition that fails alone does not hold: a reachable one failed the
// whole render already
const takenBranch = (parsed: ParsedTemplate, workspace: string, chain: ChainBlock): number =>
  chain.branches.findIndex((branch) => branch.marker === 'else' || conditionHolds(parsed, workspace, branch));

const spansOf = (chain: ChainBlock, taken: number): Span[] =>
  chain.branches.map((branch, index) => ({ from: branch.line, to: (chain.branches[index + 1]?.line ?? chain.endLine) - 1, holds: index === taken }));

// A marker renders to nothing; the line ending after it stays, so it is the empty line, its \r kept
const markerText = (source: string): string => (source.endsWith('\r') ? '\r' : '');

function previewLines(parsed: ParsedTemplate, map: TemplateMap, workspace: string): PreviewLine[] {
  const chains = chainsOf(map.blocks);
  const spans = chains.flatMap((chain) => spansOf(chain, takenBranch(parsed, workspace, chain)));
  const markers = new Set(chains.flatMap((chain) => [...chain.branches.map((branch) => branch.line), chain.endLine]));
  // split without dropping the final piece: join('\n') gives the text back, line for line with the editor's model
  return parsed.body.split('\n').map((source, index) => {
    const line = parsed.bodyLine + index;
    const isMarker = markers.has(line);
    const holds = spans.every((span) => line < span.from || line > span.to || span.holds); // every branch around it holds
    return { text: isMarker ? markerText(source) : (renderFragment(parsed, workspace, source) ?? source), holds, isMarker, line };
  });
}

/** The template as `workspace` gets it (decisions 23, 24): the delivered header and every body line resolved, the lines that hold joining to
 * exactly renderTemplate's text; the render's errors when it fails. */
export function previewTemplate(parsed: ParsedTemplate, map: TemplateMap, workspace: string): Preview {
  const render = renderTemplate(parsed, workspace);
  if (!render.ok) return render;
  const header = deliveredHeader(parsed);
  const lines = previewLines(parsed, map, workspace);
  if (header + lines.filter((l) => l.holds).map((l) => l.text).join('\n') === render.text) return { ok: true, header, lines, isExact: true };
  // ponytail: what a line alone cannot render (a loop, a capture, a trimmed tag) shows as the render's text, undimmed; a block-level preview
  // would follow those, add it when a shipped template uses one
  const body = render.text.slice(header.length).split('\n');
  return { ok: true, header, lines: body.map((text, index) => ({ text, holds: true, isMarker: false, line: parsed.bodyLine + index })), isExact: false };
}
