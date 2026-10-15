// The block map of a template's body (#311, node 1.2 of #309): heading blocks, conditional chains, the references each block makes,
// start lines and the collapse structure. Node-free, like src/template.ts: the editor's outline and the server read the same map.
import type { Condition } from './template-condition.js';
import type { TemplateError } from './template.js';

export type ReferenceKind = 'skill' | 'agent' | 'skill-or-agent' | 'script';

export interface Reference {
  kind: ReferenceKind;
  name: string;
  line: number;
}

export interface Catalogue {
  skills: string[];
  agents: string[];
}

export type MapBlock =
  | { kind: 'introduction'; line: number; endLine: number; references: Reference[] }
  | {
      kind: 'heading';
      level: 2 | 3;
      title: string;
      line: number;
      endLine: number;
      references: Reference[];
      children: MapBlock[];
      count: number;
    }
  | { kind: 'chain'; tag: 'if' | 'unless'; line: number; endLine: number; branches: MapBranch[] };

export interface MapBranch {
  marker: 'if' | 'unless' | 'elsif' | 'else';
  conditionText: string; // '' for else
  condition: Condition | null; // null for else and for a condition the model cannot hold
  line: number; // the marker's line
  references: Reference[];
  children: MapBlock[];
}

export interface TemplateMap {
  blocks: MapBlock[];
  errors: TemplateError[];
}

const NAME = '[a-z0-9][a-z0-9-]*';
// A word starts at the line's start, after whitespace or after one of ( [ ` " ' — so src/ui, /Users/me/x and me@mail.com hold none.
const WORD_START = '(?<=^|[\\s(\\[`"\'])';
// A name ends where no path (/), longer name (-) or file extension (.x) goes on: /x/y and p:x//url are not calls.
const WORD_END = '(?![\\w/-]|\\.\\w)';
const WORD = new RegExp(`${WORD_START}(\\\\?)([/@]?)((?:${NAME}:)?${NAME})${WORD_END}`, 'g');
const SCRIPT = new RegExp(`${WORD_START}((?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:py|sh|js|mjs|ts))${WORD_END}`, 'g');

function nameKind(sigil: string, name: string, catalogue?: Catalogue): ReferenceKind | undefined {
  if (sigil === '/') return 'skill';
  if (sigil === '@') return 'agent';
  if (catalogue?.skills.includes(name)) return 'skill';
  if (catalogue?.agents.includes(name)) return 'agent';
  // p:x names a plugin's skill or agent; a bare word without the catalogue would turn prose into chips
  return name.includes(':') ? 'skill-or-agent' : undefined;
}

export function findReferences(line: string, lineNumber: number, catalogue?: Catalogue): Reference[] {
  const names = [...line.matchAll(WORD)].flatMap((match) => {
    const kind = match[1] === '' ? nameKind(match[2], match[3], catalogue) : undefined; // \/x and \@x are literal
    return kind === undefined ? [] : [{ at: match.index ?? 0, reference: { kind, name: match[3], line: lineNumber } }];
  });
  const scripts = [...line.matchAll(SCRIPT)].map((match) => ({
    at: match.index ?? 0,
    reference: { kind: 'script' as const, name: match[1], line: lineNumber },
  }));
  return [...names, ...scripts].sort((a, b) => a.at - b.at).map((found) => found.reference);
}
