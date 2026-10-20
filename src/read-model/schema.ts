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
  // #187: the PR page's own rows. Reviews keep the replace rule (submitted_at for updated_at); a head's checks are replaced whole. The refill:
  // every PR poll part and the batch read again with the new fields, and every repos row with methods
  `CREATE TABLE pull_reviews (source TEXT NOT NULL, node_id TEXT NOT NULL, pull_node_id TEXT NOT NULL, repository TEXT NOT NULL, author TEXT,
    state TEXT NOT NULL, body TEXT NOT NULL, submitted_at TEXT NOT NULL, written_at INTEGER, PRIMARY KEY (source, node_id));
  CREATE INDEX pull_reviews_by_pull ON pull_reviews (source, pull_node_id, submitted_at);
  CREATE TABLE pull_checks (source TEXT NOT NULL, pull_node_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
    url TEXT, started_at TEXT, at TEXT, PRIMARY KEY (source, pull_node_id, position));
  ALTER TABLE pulls ADD COLUMN head_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE pulls ADD COLUMN base_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE pulls ADD COLUMN head_owner TEXT NOT NULL DEFAULT '';
  ALTER TABLE pulls ADD COLUMN base_owner TEXT NOT NULL DEFAULT '';
  ALTER TABLE pulls ADD COLUMN commits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pulls ADD COLUMN additions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pulls ADD COLUMN deletions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pulls ADD COLUMN requested TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE pulls ADD COLUMN closes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE pulls ADD COLUMN awaiting TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE repos ADD COLUMN methods TEXT NOT NULL DEFAULT '[]';
  UPDATE sync_scopes SET cursor = NULL, etag = NULL WHERE kind LIKE 'pull/%';
  UPDATE sync_scopes SET etag = NULL WHERE kind = 'repo';
  UPDATE pulls SET read_at = NULL;`,
  // #190: a Project's items as their GraphQL nodes, replaced on the item's own updated_at; relations beside them, outside that rule; and each
  // listing's order, per source and scope (the Project plus its filter text), so two sources over one Project keep their own
  `CREATE TABLE project_items (source TEXT NOT NULL, node_id TEXT NOT NULL, project TEXT NOT NULL, updated_at TEXT NOT NULL, node TEXT NOT NULL,
    relations TEXT, written_at INTEGER, PRIMARY KEY (source, node_id));
  CREATE INDEX project_items_by_project ON project_items (source, project);
  CREATE TABLE project_listings (source TEXT NOT NULL, scope TEXT NOT NULL, position INTEGER NOT NULL, node_id TEXT NOT NULL,
    PRIMARY KEY (source, scope, position));`,
  // #282: the items normalized. The JSON nodes and their scoped listings go (the next poll pays one full read); an item keeps its own columns, its
  // values, its issue's relations, its Project's fields and its repository's options each get a table; issues gains what only the Project read
  // says of an issue, written by that read under its own rule
  `DROP TABLE project_listings;
  DROP TABLE project_items;
  CREATE TABLE project_items (source TEXT NOT NULL, node_id TEXT NOT NULL, project TEXT NOT NULL, content_type TEXT, issue_node_id TEXT,
    blocking_read INTEGER, values_sig TEXT NOT NULL, updated_at TEXT NOT NULL, written_at INTEGER, PRIMARY KEY (source, node_id));
  CREATE INDEX project_items_by_project ON project_items (source, project);
  CREATE TABLE project_listings (source TEXT NOT NULL, project TEXT NOT NULL, position INTEGER NOT NULL, node_id TEXT NOT NULL,
    PRIMARY KEY (source, project, position));
  CREATE TABLE item_field_values (source TEXT NOT NULL, item_node_id TEXT NOT NULL, field TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (source, item_node_id, field));
  CREATE INDEX item_field_values_by_value ON item_field_values (source, field, value);
  CREATE TABLE project_fields (source TEXT NOT NULL, project TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, data_type TEXT,
    options TEXT, PRIMARY KEY (source, project, position));
  CREATE TABLE issue_relations (source TEXT NOT NULL, issue_node_id TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL,
    node_id TEXT, number INTEGER, title TEXT, state TEXT NOT NULL, repository TEXT, PRIMARY KEY (source, issue_node_id, kind, position));
  CREATE TABLE repo_assignees (source TEXT NOT NULL, repository TEXT NOT NULL, login TEXT NOT NULL, PRIMARY KEY (source, repository, login));
  -- the \`issueTypes\` scope's sync_scopes row is keyed by the owner in its repository column
  CREATE TABLE repo_milestones (source TEXT NOT NULL, repository TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY (source, repository, title));
  CREATE TABLE owner_issue_types (source TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (source, owner, name));
  ALTER TABLE issues ADD COLUMN url TEXT;
  ALTER TABLE issues ADD COLUMN milestone TEXT;
  ALTER TABLE issues ADD COLUMN issue_type TEXT;
  ALTER TABLE issues ADD COLUMN parent_number INTEGER;
  ALTER TABLE issues ADD COLUMN parent_title TEXT;
  ALTER TABLE issues ADD COLUMN sub_issues_total INTEGER;
  ALTER TABLE issues ADD COLUMN sub_issues_completed INTEGER;`,
];
