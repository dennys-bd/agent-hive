import { createGithubBoard, type Exec } from './boards/github.js';
import type { Board, Config } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it (Task 3); github ignores it
  exec?: Exec; // gh runner, injectable for tests
}

export function createBoard(config: Config, deps: BoardDeps): Board {
  // Task 3 replaces this guard with the markdown adapter
  if (config.board.type !== 'github') throw new Error(`board.type "${config.board.type}" ainda não suportado`);
  return createGithubBoard(config.board, config.status, deps.exec);
}
