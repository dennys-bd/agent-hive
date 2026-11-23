import type { CatalogueItem, ItemState } from '../../../types';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN } from '@/lib/plugins';

export interface StateLook { label: MessageKey; dot: string; text: string; chip: string }

/** Each state's copy and colour (#313, the handoff's "Estados e regras"): update available yellow and customized blue are status colours, a
 * workspace's item faint. Only the legend draws the hive original's hollow ring: a row of the original needs no mark (#492). */
export const STATE_LOOK: Record<ItemState, StateLook> = {
  'update available': { label: 'plugins.state.updateAvailable', dot: 'bg-waiting', text: 'text-foreground', chip: 'border-waiting text-waiting' },
  customized: { label: 'plugins.state.customized', dot: 'bg-review', text: 'text-foreground', chip: 'border-review text-review' },
  original: { label: 'plugins.state.original', dot: 'border border-faint', text: 'text-muted-foreground', chip: 'border-border text-muted-foreground' },
  workspace: { label: 'plugins.state.workspace', dot: 'bg-faint', text: 'text-muted-foreground', chip: 'border-border text-muted-foreground' },
};
/** The legend's order, the handoff's. */
export const LEGEND: readonly ItemState[] = ['original', 'customized', 'update available', 'workspace'];

// #983: a user-created item is customized from its first version, so it keeps customized's colours under a word of its own
const OWN_LOOK: StateLook = { ...STATE_LOOK.customized, label: 'plugins.state.userCreated' };
/** An item's look in the head, the list, the sidebar and the version menu: "created by you" for a user-created one, else its state's. */
export const lookOf = (item: CatalogueItem): StateLook => (item.userCreated ? OWN_LOOK : STATE_LOOK[item.state]);

/** An item's state dot: named for a screen reader where it is the only sign of the state, decorative next to the state's label. `label`
 * (#983): the word to name it by when it is not the state's own, as a user-created item's. */
export function StateDot({ state, label: named, isDecorative = false, isLegend = false }: { state: ItemState; label?: MessageKey; isDecorative?: boolean; isLegend?: boolean }) {
  // The screen hides the original's dot but keeps its room, so the state words of a list still line up
  if (state === 'original' && !isLegend) return <span aria-hidden="true" className="invisible size-1.5 shrink-0" />;
  const label = t(named ?? STATE_LOOK[state].label);
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
export const CHIP = 'rounded-full border px-1.5 font-normal text-xs';
