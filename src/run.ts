import { resolve } from 'node:path';
import { bootHive } from './hive.js';
import { readPlanLimits } from './plan-limits.js';

const repo = process.argv[2];
if (!repo) {
  console.error('uso: node dist/src/run.js <repo>');
  process.exit(2);
}
bootHive(resolve(repo), { readPlanLimits }).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
