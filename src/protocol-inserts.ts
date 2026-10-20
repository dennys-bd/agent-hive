// The user's protocol passages (#336). No node imports, so the protocol screen's preview (#337) runs the same code.
import type { TemplateError } from './template.js';

export interface Passage { id: string; text: string } // text: the whole file, header included
export interface RenderedPassage { id: string; after: string; orphan: boolean; text?: string; errors: TemplateError[] } // text absent on an error
