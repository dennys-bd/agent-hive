import { CircleAlertIcon, WaypointsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { routeOf } from '../../create-route';
import type { Flow, SourceConfig } from '../../types';
import { t } from '@/i18n';
import { filterSentence, opWord } from '@/lib/route-text';

export interface CreateRouteBoxProps { source: string; title: string; labels: string[]; status: string | null; sources: readonly SourceConfig[]; flows: readonly Flow[] }

// The PrPage pattern: split the template on its one placeholder and bold the value, so no name can reshape the line
const bolded = (key: Parameters<typeof t>[0], name: string, value: string): ReactNode => {
  const [before, after] = t(key).split(`{${name}}`);
  return <>{before}<b>{value}</b>{after}</>;
};

type Taken = Extract<ReturnType<typeof routeOf>, { taken: true }>;

function reasonOf(route: Taken, source: SourceConfig | undefined): string {
  const { reason } = route;
  if (reason.kind === 'defaults') return t('create.route.reason.defaults');
  if (reason.kind === 'status') return t('create.route.reason.status', { status: reason.status, stage: route.entry?.stage ?? '' });
  const rule = source?.taskProps.rules[reason.index];
  return rule === undefined ? '' : t('create.route.reason.rule', { n: reason.index + 1, field: rule.field, op: opWord(rule.op), value: rule.value });
}

function takenLine(route: Taken, source: string): ReactNode {
  const workspace = route.workspace === undefined ? t('create.route.noWorkspace') : bolded('create.route.workspace', 'workspace', route.workspace);
  const entry = route.entry === null ? <b>{t('create.route.noFlow')}</b> : bolded('create.route.enters', 'entry', `${route.entry.flow} · ${route.entry.stage}`);
  return <>{bolded('create.route.via', 'source', source)} {workspace} · {entry}</>;
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
      <span>{line}</span>
      {reason !== '' && <><span /><span className="text-muted-foreground">{reason}</span></>}
    </div>
  );
}
