import { type DragEvent, useRef } from 'react';

// The block map's drag (#319, decision 21), native HTML5 as task-drag.ts and tree-drag.ts do: a block's handle drags it, and only its
// siblings' rows take the drop, since moveBlock moves a block only among them. A ref holds the dragged block: dataTransfer is unreadable
// until the drop. ponytail: no drop highlight; add one when a drag reads unclear.
export interface HandleProps { draggable: true; onDragStart(e: DragEvent): void; onDragEnd(): void }
export interface DropProps { onDragOver(e: DragEvent): void; onDrop(e: DragEvent): void }
export interface MapDrag { handleProps(line: number, parent: string): HandleProps; dropProps(line: number, parent: string, index: number): DropProps }

export function useMapDrag(onMove: (line: number, index: number) => void): MapDrag {
  const dragged = useRef<{ line: number; parent: string } | undefined>(undefined);
  // A row of another parent lets the event go on: the block around it may be the dragged one's sibling
  const isSibling = (parent: string): boolean => dragged.current?.parent === parent;
  return {
    handleProps: (line, parent) => ({
      draggable: true,
      onDragStart: (e) => {
        e.stopPropagation(); // a nested block's handle is inside its parent's row
        e.dataTransfer.setData('text/plain', String(line)); // Firefox starts no drag without data
        e.dataTransfer.effectAllowed = 'move';
        dragged.current = { line, parent };
      },
      onDragEnd: () => { dragged.current = undefined; },
    }),
    dropProps: (line, parent, index) => ({
      onDragOver: (e) => {
        if (!isSibling(parent)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: (e) => {
        if (!isSibling(parent)) return;
        e.preventDefault();
        e.stopPropagation();
        const from = dragged.current?.line;
        dragged.current = undefined;
        if (from !== undefined && from !== line) onMove(from, index);
      },
    }),
  };
}
