// A .drawio file as the diagram pane loads it (#956): draw.io's own XML, or a pending diagram an agent wrote without coordinates, marked
// with hive-layout on its <mxfile> or holding a <hive-mermaid> element. Pure, so it is tested without a frame.

/** draw.io's ELK presets (v32.6.10's layout menu, checked in vendor/drawio): what `load`'s layout field takes. */
export const LAYOUT_PRESETS = ['verticalFlow', 'horizontalFlow', 'verticalTree', 'horizontalTree', 'radialTree', 'organic'] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

/** What a file asks of the pane: load it as is, lay it out with a preset, or import its Mermaid. */
export type DrawioFile = { kind: 'xml'; xml: string } | { kind: 'layout'; xml: string; preset: LayoutPreset } | { kind: 'mermaid'; text: string };

const LAYOUT_ATTRIBUTE = 'hive-layout';
const MERMAID_ELEMENT = 'hive-mermaid';

const isPreset = (value: string | null): value is LayoutPreset => (LAYOUT_PRESETS as readonly (string | null)[]).includes(value);

/** The file's kind (#956). Text that does not parse, a root that is no <mxfile> or an unknown preset loads as is: draw.io names its own
 *  error, and draw.io's XML never carries the marker, so its first autosave clears it. */
export function parseDrawioFile(text: string): DrawioFile {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length > 0 || root.nodeName !== 'mxfile') return { kind: 'xml', xml: text };
  const mermaid = root.getElementsByTagName(MERMAID_ELEMENT)[0];
  if (mermaid !== undefined) return { kind: 'mermaid', text: mermaid.textContent ?? '' };
  const preset = root.getAttribute(LAYOUT_ATTRIBUTE);
  if (!isPreset(preset)) return { kind: 'xml', xml: text };
  root.removeAttribute(LAYOUT_ATTRIBUTE); // this call's own parsed document, never the caller's text
  return { kind: 'layout', xml: new XMLSerializer().serializeToString(doc), preset };
}

/** The `load` action for the file (#956): autosave on, and no save or exit button, since the pane writes every autosave itself. */
export function loadMessage(file: DrawioFile): Record<string, unknown> {
  const chrome = { action: 'load', autosave: 1, noSaveBtn: 1, noExitBtn: 1 };
  if (file.kind === 'mermaid') return { ...chrome, descriptor: { format: 'mermaid', data: file.text } };
  return file.kind === 'layout' ? { ...chrome, xml: file.xml, layout: file.preset } : { ...chrome, xml: file.xml };
}

/** After a preset's load (spike probe 5): libavoid routes the edges around the nodes the preset placed. Never `merge`. */
export const ROUTE_EDGES = { action: 'layout', layouts: 'libavoid' } as const;
