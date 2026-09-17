import { createGithubBoard, type Exec } from './boards/github.js';
import { createMarkdownBoard, markdownPath } from './boards/markdown.js';
import type { Board, Config } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it; github ignores it
  exec?: Exec; // gh runner, injectable for tests
}

export function createBoard(config: Config, deps: BoardDeps): Board {
  const { board, status, epics } = config;
  switch (board.type) {
    case 'github':
      return createGithubBoard(board, status, epics, deps.exec);
    case 'markdown':
      return createMarkdownBoard(markdownPath(deps.repo, board.path), status);
  }
}
