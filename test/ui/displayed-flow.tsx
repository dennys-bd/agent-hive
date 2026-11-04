import type { ComponentProps } from 'react';
import { Flow } from '@/components/Flow';
import { useDisplayOptions } from '@/hooks/use-flow-view';

/** Flow as Center renders it (#574): with the one display value, which a remount reads back from the view state. */
export function DisplayedFlow(props: Omit<ComponentProps<typeof Flow>, 'display'>) {
  const display = useDisplayOptions();
  return <Flow {...props} display={display} />;
}
