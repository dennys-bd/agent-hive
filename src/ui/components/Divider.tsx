import type { KeyboardEvent, PointerEvent, RefObject } from 'react';

export interface DividerProps {
  axis: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  keys: Record<string, number>;
  label: string;
  measure: RefObject<HTMLElement | null>;
  toValue(rect: DOMRect, clientX: number, clientY: number): number;
  onChange(value: number): void;
  onDoubleClick?(): void;
}

// A 1px line, as every division of the window (redesign 00), with a wider grab area drawn past it on both sides by its ::before
const VERTICAL = 'w-px cursor-col-resize before:inset-y-0 before:-inset-x-1';
const HORIZONTAL = 'h-px cursor-row-resize before:inset-x-0 before:-inset-y-1';

// A splitter between two panes (#251, #339, #341): shared by the dock groups (#342) and the session list/terminal split. The
// pointer computes the new value from its own measured rect (`measure`, `toValue`); the arrows nudge it by `keys`. The caller clamps `onChange`'s value.
export function Divider({ axis, value, min, max, keys, label, measure, toValue, onChange, onDoubleClick }: DividerProps) {
  const vertical = axis === 'vertical';
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = measure.current?.getBoundingClientRect();
    if (!rect || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onChange(toValue(rect, event.clientX, event.clientY));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (keys[event.key] !== undefined) onChange(value + keys[event.key]);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the WAI-ARIA splitter pattern: arrows resize it (#251)
    <div
      role="separator" tabIndex={0} aria-label={label} aria-orientation={axis}
      aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
      className={`relative z-10 shrink-0 bg-border before:absolute before:content-[''] ${vertical ? VERTICAL : HORIZONTAL}`}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={onPointerMove} onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
