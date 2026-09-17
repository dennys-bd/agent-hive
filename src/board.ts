import { createGithubBoard, ghExec, loggedExec, type Exec } from './boards/github.js';
import { createMarkdownBoard, markdownPath } from './boards/markdown.js';
import type { Logger } from './log.js';
import type { Board, BoardSpec } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it; github ignores it
  exec?: Exec; // gh runner, injectable for tests
  log?: Logger; // github: every gh call is logged at debug; markdown has nothing to log beyond what the server's fail covers
}

export function createBoard(config: BoardSpec, deps: BoardDeps): Board {
  const { board, status, epics } = config;
  switch (board.type) {
    case 'github': {
      const exec = deps.exec ?? ghExec;
      return createGithubBoard(board, status, epics, deps.log ? loggedExec(exec, deps.log) : exec);
    }
    case 'markdown':
      return createMarkdownBoard(markdownPath(deps.repo, board.path), status);
  }
}
