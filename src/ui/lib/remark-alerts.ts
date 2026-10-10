// GitHub's alerts (#697): a blockquote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION] (any case) becomes an
// aside carrying its kind, the marker and its line break gone; DocMarkdown draws it. Our own lines instead of a dependency, whose raw SVG and
// classes the sanitizer would strip anyway. The mdast shapes are written here: @types/mdast is no direct dependency.

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The part of an mdast node the plugin reads and writes. */
export interface MdNode { type: string; value?: string; children?: MdNode[]; data?: { hName?: string; hProperties?: Record<string, string> } }

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

export const isAlertKind = (value: unknown): value is AlertKind => typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);

// The blockquote as an alert, or as it was: the marker must open the first text of its first paragraph. A paragraph left empty goes
function toAlert(quote: MdNode): MdNode {
  const [first, ...rest] = quote.children ?? [];
  const lead = first?.type === 'paragraph' ? first.children?.[0] : undefined;
  const found = lead?.type === 'text' ? MARKER.exec(lead.value ?? '') : null;
  if (first === undefined || lead === undefined || found === null) return quote;
  const value = (lead.value ?? '').slice(found[0].length);
  const kept = [...(value === '' ? [] : [{ ...lead, value }]), ...(first.children ?? []).slice(1)];
  const children = [...(kept.length === 0 ? [] : [{ ...first, children: kept }]), ...rest];
  return { ...quote, children, data: { ...quote.data, hName: 'aside', hProperties: { dataAlert: found[1].toLowerCase() } } };
}

// Every node rebuilt bottom-up, each blockquote through toAlert (one in a list or in another quote too); the input is never touched
function walk(node: MdNode): MdNode {
  const next = node.children === undefined ? node : { ...node, children: node.children.map(walk) };
  return next.type === 'blockquote' ? toAlert(next) : next;
}

/** The remark plugin (#697): its transformer answers a new tree. */
export function remarkAlerts(): (tree: MdNode) => MdNode {
  return walk;
}
