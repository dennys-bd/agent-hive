import type { TaskTree } from '../../src/types.js';

/** What today's 5-run taskTree answered on treeRepo (recorded before #502 changed it; root left out, it is a temp path). Frozen: never
 *  regenerate it from the new code. */
export const TODAY_TREE: Omit<TaskTree, 'root'> = {
  branch: 'main',
  files: ['newdir/sub/y.ts', 'newdir/x.ts', '.gitignore', 'a.txt', 'build/keep.txt', 'moved.ts', 'src/b.ts'],
  marks: { 'gone.txt': 'D', 'moved.ts': 'A', 'src/b.ts': 'M', 'newdir/sub/y.ts': 'A', 'newdir/x.ts': 'A', 'vendor/lib/': 'A' },
  folders: ['empty', 'logs', 'vendor'],
  ignored: { files: ['build/app.log', 'debug.log', 'logs/a.log', 'logs/b.log'], folders: ['logs', 'node_modules'] },
};
