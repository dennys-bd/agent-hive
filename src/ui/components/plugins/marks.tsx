import type { ItemState } from '../../../types';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN } from '@/lib/plugins';

interface StateLook { label: MessageKey; dot: string; text: string; chip: string }

/** Each state's copy and colour (#313, the handoff's "Estados e regras"): update available yellow and customized blue are status colours, the
 * hive original a hollow dot, a workspace's item grey. */
export const STATE_LOOK: Record<ItemState, StateLook> = {
  'update available': { label: 'plugins.state.updateAvailable', dot: 'bg-waiting', text: 'text-foreground', chip: 'border-waiting text-waiting' },
  customized: { label: 'plugins.state.customized', dot: 'bg-review', text: 'text-foreground', chip: 'border-review text-review' },
  original: { label: 'plugins.state.original', dot: 'border border-muted-foreground', text: 'text-muted-foreground', chip: 'border-border text-muted-foreground' },
  workspace: { label: 'plugins.state.workspace', dot: 'bg-muted-foreground', text: 'text-muted-foreground', chip: 'border-border text-muted-foreground' },
};
/** The legend's order, the handoff's. */
export const LEGEND: readonly ItemState[] = ['original', 'customized', 'update available', 'workspace'];

/** An item's state dot: named for a screen reader where it is the only sign of the state, decorative next to the state's label. */
export function StateDot({ state, isDecorative = false }: { state: ItemState; isDecorative?: boolean }) {
  const label = t(STATE_LOOK[state].label);
  const look = `size-1.5 shrink-0 rounded-full ${STATE_LOOK[state].dot}`;
  if (isDecorative) return <span aria-hidden="true" data-state={state} className={look} />;
  return <span role="img" aria-label={label} title={label} data-state={state} className={look} />;
}

/** A group's mark (#313, decision 7): a workspace's colour square, the only use of its colour here; the hive group's plain dot. */
export function OriginMark({ origin }: { origin: string }) {
  if (origin !== HIVE_ORIGIN) return <WorkspaceSquare name={origin} />;
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-foreground" />;
}

/** A state chip's shape (#313): the head's chip and the version menu's rows draw it alike. */
export const CHIP = 'rounded-full border px-1.5 font-normal text-[11px]';
