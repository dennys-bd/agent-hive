// The read model's schema (#178), one entry per version: PRAGMA user_version is the index after the last entry applied. A later node
// appends an entry; a shipped one is never edited, since every file at that version already ran it.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE issues (source TEXT NOT NULL, node_id TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT, labels TEXT NOT NULL, assignees TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, comments INTEGER NOT NULL, written_at INTEGER,
    PRIMARY KEY (source, node_id));
  CREATE INDEX issues_by_state ON issues (source, repository, kind, state, updated_at);
  CREATE INDEX issues_by_number ON issues (source, repository, number);
  CREATE TABLE issue_pull_requests (source TEXT NOT NULL, issue_node_id TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
    state TEXT NOT NULL, draft INTEGER NOT NULL, checks TEXT, PRIMARY KEY (source, issue_node_id, number));
  CREATE TABLE comments (source TEXT NOT NULL, node_id TEXT NOT NULL, issue_node_id TEXT NOT NULL, repository TEXT NOT NULL, url TEXT NOT NULL,
    author TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, written_at INTEGER, PRIMARY KEY (source, node_id));
  CREATE INDEX comments_by_issue ON comments (source, issue_node_id, created_at);
  CREATE TABLE sync_scopes (source TEXT NOT NULL, repository TEXT NOT NULL, kind TEXT NOT NULL, cursor TEXT, etag TEXT, synced_at TEXT,
    PRIMARY KEY (source, repository, kind));`,
  // #181: the repository summaries' and the labels popover's own data, each replaced whole by its conditional REST scope
  `CREATE TABLE repos (source TEXT NOT NULL, repository TEXT NOT NULL, url TEXT NOT NULL, can_push INTEGER NOT NULL, issues_enabled INTEGER NOT NULL,
    fork_parent TEXT, pushed_at TEXT, PRIMARY KEY (source, repository));
  CREATE TABLE labels (source TEXT NOT NULL, repository TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (source, repository, name));`,
  // #186: a PR's own fields beside its issues row, each column written by one reader. The issues scopes read again from the start (synced_at
  // kept), so every stored PR gets its flags and no list falls back to "still syncing"
  `CREATE TABLE pulls (source TEXT NOT NULL, node_id TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
    draft INTEGER NOT NULL DEFAULT 0, merged_at TEXT, head_sha TEXT, merge_state TEXT NOT NULL DEFAULT 'unknown', checks TEXT, decision TEXT,
    read_at TEXT, PRIMARY KEY (source, node_id));
  CREATE INDEX pulls_by_number ON pulls (source, repository, number);
  UPDATE sync_scopes SET cursor = NULL, etag = NULL WHERE kind = 'issues';`,
];
