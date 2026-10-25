package store

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

func (s *Store) migrateSessions() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
 last_synced_at INTEGER NOT NULL DEFAULT 0, additional_directories TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);
CREATE TABLE IF NOT EXISTS session_organization (session_id TEXT PRIMARY KEY REFERENCES sessions(id), pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS conversation_drafts (key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_input_requests (session_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(session_id,request_id));
CREATE TABLE IF NOT EXISTS task_session_pins (
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 session_id TEXT NOT NULL REFERENCES sessions(id), PRIMARY KEY(requirement_id,session_id));
CREATE TABLE IF NOT EXISTS conversation_create_requests (
 request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '');`)
	if err != nil {
		return err
	}
	var migrated int
	if err := tx.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version='sessions_index_v1'`).Scan(&migrated); err != nil {
		return err
	}
	if migrated == 0 {
		if err := backfillSessions(tx); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version) VALUES('sessions_index_v1')`); err != nil {
			return err
		}
	}
	var titleColumns int
	if err := tx.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='title_source'`).Scan(&titleColumns); err != nil {
		return err
	}
	if titleColumns == 0 {
		if _, err := tx.Exec(`ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN title_changed_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET title_source='legacy' WHERE name<>'';`); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Keep legacy tables intact for old exports and launch adapters. Only explicit
// manual links become pins; discovered directory matches are never ownership.
func backfillSessions(tx *sql.Tx) error {
	_, err := tx.Exec(`
INSERT OR IGNORE INTO sessions(id,name,cwd,created_at,updated_at,source)
 SELECT session_id,name,cwd,created_at,updated_at,source FROM requirement_sessions ORDER BY updated_at DESC;
INSERT OR IGNORE INTO task_session_pins(requirement_id,session_id)
 SELECT requirement_id,session_id FROM requirement_sessions WHERE source='manual';
INSERT OR IGNORE INTO conversation_create_requests(request_id,fingerprint,session_id)
 SELECT 'task:' || requirement_id || ':' || request_id,'',session_id FROM session_create_requests;`)
	return err
}

func (s *Store) SaveSession(v model.Session, observedAt ...int64) error {
	started := time.Now().UnixNano()
	if len(observedAt) > 0 {
		started = observedAt[0]
	}
	v.Name = strings.TrimSpace(v.Name)
	if v.Name != "" && v.TitleSource == "" {
		v.TitleSource = "codex"
	}
	_, err := s.DB.Exec(`INSERT INTO sessions(id,name,cwd,created_at,updated_at,source,last_synced_at,title_source,title_changed_at)
 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
 name=CASE WHEN excluded.name<>'' AND sessions.title_changed_at<excluded.title_changed_at THEN excluded.name ELSE sessions.name END,
 title_source=CASE WHEN excluded.name<>'' AND sessions.name<>excluded.name AND sessions.title_changed_at<excluded.title_changed_at THEN excluded.title_source ELSE sessions.title_source END,
 title_changed_at=CASE WHEN excluded.name<>'' AND sessions.name<>excluded.name AND sessions.title_changed_at<excluded.title_changed_at THEN excluded.title_changed_at ELSE sessions.title_changed_at END,
 cwd=excluded.cwd,
 created_at=excluded.created_at,updated_at=excluded.updated_at,last_synced_at=excluded.last_synced_at,
 source=CASE WHEN excluded.source='workbench' THEN excluded.source ELSE sessions.source END`,
		v.ID, v.Name, platform.CleanWorkspacePath(v.Cwd), v.CreatedAt, v.UpdatedAt, v.Source, time.Now().Unix(), v.TitleSource, started)
	return err
}

// SetSessionTitle follows a successful explicit Codex name write. The timestamp
// prevents metadata reads started before that write from restoring an old name.
func (s *Store) SetSessionTitle(id, name, source string) error {
	return MustAffected(s.DB.Exec(`UPDATE sessions SET name=?,title_source=?,title_changed_at=MAX(title_changed_at+1,?) WHERE id=?`, name, source, time.Now().UnixNano(), id))
}

// Notifications have no revision. Conflicting events cannot overwrite a manual
// name; a fresh metadata read can still discover a later rename in Codex.
func (s *Store) ObserveSessionTitle(id, name string) (bool, error) {
	result, err := s.DB.Exec(`UPDATE sessions SET name=?,
 title_source=CASE WHEN name=? THEN title_source ELSE 'codex' END,
 title_changed_at=CASE WHEN name=? THEN title_changed_at ELSE MAX(title_changed_at+1,?) END
 WHERE id=? AND (title_source<>'manual' OR name=?)`, name, name, name, time.Now().UnixNano(), id, name)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func scanSession(scan func(...any) error) (model.Session, error) {
	var v model.Session
	var directories string
	err := scan(&v.ID, &v.Name, &v.Cwd, &v.CreatedAt, &v.UpdatedAt, &v.Source, &v.LastSyncedAt, &directories, &v.Pinned, &v.Archived, &v.TitleSource, &v.TitleChangedAt)
	if err == nil {
		err = json.Unmarshal([]byte(directories), &v.AdditionalDirectories)
	}
	return v, err
}

const sessionColumns = `id,name,cwd,created_at,updated_at,source,last_synced_at,additional_directories,COALESCE((SELECT pinned FROM session_organization WHERE session_id=sessions.id),0),COALESCE((SELECT archived FROM session_organization WHERE session_id=sessions.id),0),title_source,title_changed_at`

func (s *Store) Session(id string) (model.Session, error) {
	return scanSession(s.DB.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE id=?`, id).Scan)
}

func (s *Store) Sessions() ([]model.Session, error) {
	rows, err := s.DB.Query(`SELECT ` + sessionColumns + ` FROM sessions ORDER BY updated_at DESC,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Session{}
	for rows.Next() {
		v, err := scanSession(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) SaveSessionDirectories(id string, directories []string) error {
	if directories == nil {
		directories = []string{}
	}
	raw, err := json.Marshal(directories)
	if err != nil {
		return err
	}
	return MustAffected(s.DB.Exec(`UPDATE sessions SET additional_directories=? WHERE id=?`, string(raw), id))
}

func (s *Store) PinnedSessionIDs(task string) (map[string]bool, error) {
	rows, err := s.DB.Query(`SELECT session_id FROM task_session_pins WHERE requirement_id=?`, task)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) OrganizeSession(id string, pinned, archived bool) error {
	_, err := s.DB.Exec(`INSERT INTO session_organization(session_id,pinned,archived,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived,updated_at=excluded.updated_at`, id, pinned, archived, time.Now().UnixMilli())
	return err
}

// A discovery response started before an explicit organization action cannot
// overwrite that action when the slower scan finally returns.
func (s *Store) ObserveSessionArchive(id string, archived bool, observedAt int64) error {
	_, err := s.DB.Exec(`INSERT INTO session_organization(session_id,archived) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET archived=excluded.archived WHERE session_organization.updated_at < ?`, id, archived, observedAt)
	return err
}
