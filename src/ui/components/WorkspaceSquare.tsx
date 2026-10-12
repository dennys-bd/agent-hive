import { useWorkspaceColor } from '@/lib/workspace-color';

interface WorkspaceSquareProps { name?: string; color?: string; className?: string; title?: string }

/** A workspace's square (#78): the design system's workspace-colour exception, drawn here and nowhere else. An explicit color (a Settings
 * draft row) wins over the context; no colour known (no workspace, or one that is gone) reads bg-muted. */
export function WorkspaceSquare({ name, color, className = 'size-2 rounded-[2px]', title }: WorkspaceSquareProps) {
  const known = useWorkspaceColor(name);
  const fill = color ?? known;
  return (
    <span
      aria-hidden="true" title={title} className={`shrink-0 ${fill === undefined ? 'bg-muted ' : ''}${className}`}
      style={fill === undefined ? undefined : { backgroundColor: fill }}
    />
  );
}
