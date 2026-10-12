import type { CSSProperties } from 'react';
import type { Rect } from '../../design-anchor';
import type { DesignTarget } from '../../types';
import type { PinRects } from '@/hooks/use-design-pins';
import { t } from '@/i18n';
import type { CommentState, DesignComment, DesignTheme } from '@/lib/design-comments';
import { STATUS_DOT } from '@/lib/status';

// The canvas's pins (#114): a drop per comment the bridge found, above and left of its target, the same size on screen at any zoom.

/** The gap between a pin's sharp corner and its target's corner: the bridge's hover outline offset. */
export const PIN_GAP = 6;
export const PIN_SIZE = 22; // the handoff's drop, 11 px radii
const COMPOSER_WIDTH = 340;

export type PinState = CommentState | 'edit';
export interface PinLook { className: string; style: CSSProperties }

// The design theme's own values (theme.css): the Hive's tokens on :root follow the Hive's theme, not the design's
const DESIGN_THEME: Record<DesignTheme, { ink: string; background: string; card: string; muted: string }> = {
  dark: { ink: '#e6e6e6', background: '#111418', card: '#1a1f26', muted: '#8a94a6' },
  light: { ink: '#1f2328', background: '#f5f6f8', card: '#ffffff', muted: '#5a6372' },
};
const TOKEN_PIN: Record<Exclude<PinState, 'draft' | 'resolved'>, string> = {
  edit: `${STATUS_DOT.review} text-white`, agent: `${STATUS_DOT.working} text-white`,
  replied: `${STATUS_DOT.waiting} text-[#111418]`, agentDone: `${STATUS_DOT.approval} text-white`,
};

/** A pin's colours (#114, the handoff's table): the states that wait on someone in their status token, a draft in the design's ink, a
 *  resolved one in its card; every one ringed in the design's background. */
export function pinColours(state: PinState, theme: DesignTheme): PinLook {
  const look = DESIGN_THEME[theme];
  const ring = `0 0 0 2px ${look.background}`;
  if (state === 'draft') return { className: '', style: { backgroundColor: look.ink, color: look.background, boxShadow: ring } };
  if (state === 'resolved') return { className: '', style: { backgroundColor: look.card, color: look.muted, boxShadow: ring } };
  return { className: TOKEN_PIN[state], style: { boxShadow: ring } };
}

/** A pin's place in the box (#114): the bridge's rect is in the frame's unscaled px and the box is the frame times the zoom, so the target's
 *  corner is the rect times the zoom; the pin itself is never scaled. ponytail: a target within 28 px of the design's top puts its pin
 *  past the canvas's 16 px padding; keep the pin inside if it bites. */
export const pinStyle = (rect: Rect, scale: number): { left: number; top: number; width: number; height: number } => ({
  left: rect.x * scale - PIN_GAP, top: rect.y * scale - PIN_GAP - PIN_SIZE, width: PIN_SIZE, height: PIN_SIZE,
});

/** The composer under the editing pin, its left edge kept inside the box. */
export const composerStyle = (rect: Rect, scale: number, boxWidth: number): { left: number; top: number; width: number } => ({
  left: Math.max(0, Math.min(rect.x * scale - PIN_GAP, boxWidth - COMPOSER_WIDTH)), top: rect.y * scale, width: COMPOSER_WIDTH,
});

const PIN_CLASS = 'pointer-events-auto absolute flex items-center justify-center rounded-[11px_11px_11px_2px] font-semibold text-[11px] tabular-nums';

export interface DesignPinsProps {
  items: readonly DesignComment[]; rects: PinRects; scale: number; theme: DesignTheme; selected?: string;
  /** The composer's target, drawn in --review with the pin the server will give it. */
  editing?: { target: DesignTarget; pin: number };
  onSelect(id: string): void;
}

/** The overlay over the frame (#114): it passes every pointer to the frame except on a pin. */
export function DesignPins({ items, rects, scale, theme, selected, editing, onSelect }: DesignPinsProps) {
  const edit = pinColours('edit', theme);
  return (
    <div className="pointer-events-none absolute inset-0">
      {items.map((item) => {
        const rect = rects.get(item.id);
        if (!rect) return null; // null: the target is gone; undefined: no answer since the frame's last load
        const { className, style } = pinColours(item.state, theme);
        return (
          <button
            key={item.id} type="button" data-pin={item.id} aria-label={t('design.pin', { n: item.anchor.pin })} aria-current={selected === item.id ? 'true' : undefined}
            onClick={() => onSelect(item.id)} style={{ ...style, ...pinStyle(rect, scale) }} className={`${PIN_CLASS} ${className}`}
          >
            {item.state === 'resolved' ? '✓' : item.anchor.pin}
          </button>
        );
      })}
      {/* the target's own rect: the frame is sized to its content, so its window never scrolls and document px are viewport px */}
      {editing && <span aria-hidden="true" style={{ ...edit.style, ...pinStyle(editing.target.rect, scale) }} className={`${PIN_CLASS} ${edit.className}`}>{editing.pin}</span>}
    </div>
  );
}
