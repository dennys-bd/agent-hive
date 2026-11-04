import { TasksSidebar, type TasksSidebarProps } from '@/components/tasks/TasksSidebar';
import { t } from '@/i18n';

/** The Tarefas dock tab (#456): the tasks sidebar (#572), in a region named like its tab, which MainDock's automation render prop hosts. */
export function AutomationPanel(props: TasksSidebarProps) {
  return (
    <section aria-label={t('dock.automation')} className="flex min-h-0 flex-1 flex-col">
      <TasksSidebar {...props} />
    </section>
  );
}
