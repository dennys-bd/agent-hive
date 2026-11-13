import { CircleAlertIcon, WaypointsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { routeOf } from '../../create-route';
import type { Flow, SourceConfig } from '../../types';
import { t } from '@/i18n';
import { filterSentence, opWord } from '@/lib/route-text';

export interface CreateRouteBoxProps { source: string; title: string; labels: string[]; status: string | null; sources: readonly SourceConfig[]; flows: readonly Flow[] }

// t() fills a name between these two control characters, which cannot occur in a name; the box then bolds what sits between them
const OPEN = '\u0001';
const CLOSE = '\u0002';
const mark = (name: string): string => `${OPEN}${name}${CLOSE}`;
// biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string, never reordered, and two names can be equal
const rich = (text: string): ReactNode[] => text.split(new RegExp(`${OPEN}(.*?)${CLOSE}`)).map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part));

type Taken = Extract<ReturnType<typeof routeOf>, { taken: true }>;

function reasonOf(route: Taken, source: SourceConfig | undefined): string {
  const { reason } = route;
  if (reason.kind === 'defaults') return t('create.route.reason.defaults');
  if (reason.kind === 'status') return t('create.route.reason.status', { status: reason.status, stage: route.entry?.stage ?? '' });
  const rule = source?.taskProps.rules[reason.index];
  return rule === undefined ? '' : t('create.route.reason.rule', { n: reason.index + 1, field: rule.field, op: opWord(rule.op), value: rule.value });
}

function takenLine(route: Taken, source: string): string {
  const workspace = route.workspace === undefined ? t('create.route.noWorkspace') : t('create.route.workspace', { workspace: mark(route.workspace) });
  const entry = route.entry === null ? mark(t('create.route.noFlow')) : t('create.route.enters', { entry: mark(`${route.entry.flow} · ${route.entry.stage}`) });
  return `${t('create.route.via', { source: mark(source) })} ${workspace} · ${entry}`;
}

function missReason(miss: Extract<ReturnType<typeof routeOf>, { taken: false }>['missed'], source: string): string {
  if (miss.kind === 'offProject') return t('create.route.missed.offProject', { source });
  if (miss.kind === 'status') return t('create.route.missed.status', { status: miss.status });
  return miss.kind === 'filter' ? filterSentence(source, miss.rule) : '';
}

/** Where the draft would land (#773): routeOf over the draft each render, the poll's own answer with no server call. */
export function CreateRouteBox({ source, title, labels, status, sources, flows }: CreateRouteBoxProps) {
  const route = routeOf({ source, title, labels, status }, sources, flows);
  const [Icon, line, reason] = route.taken
    ? [WaypointsIcon, takenLine(route, source), reasonOf(route, sources.find((s) => s.name === source))]
    : [CircleAlertIcon, t('create.route.missed'), missReason(route.missed, source)];
  return (
    <div role="status" aria-live="polite" className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md border px-3 py-2.5 text-xs leading-[17px] [&_b]:font-medium">
      <Icon className="mt-px size-4 text-muted-foreground" />
      <span>{rich(line)}</span>
      {reason !== '' && <><span /><span className="text-muted-foreground">{reason}</span></>}
    </div>
  );
}
