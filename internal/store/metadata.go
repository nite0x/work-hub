package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"worktree-hub/internal/platform"
)

// Explicit columns make import independent of platform and future additive
// schema migrations. No SQL identifiers supplied by a client are executed.
var metadataTables = []struct{ Name, Columns string }{
	{"projects", "id,name,path,common_dir,folder,created_at"},
	{"settings", "key,value"},
	{"requirements", "id,name,slug,description,branch,path,primary_project_id,state,created_at,has_workspace"},
	{"members", "requirement_id,project_id,path,base_commit,state,error,mode,base_ref,branch"},
	{"requirement_sessions", "requirement_id,session_id,name,cwd,created_at,updated_at,source"},
	{"session_create_requests", "requirement_id,request_id,session_id"},
	{"sessions", "id,name,cwd,created_at,updated_at,source,last_synced_at,additional_directories,title_source,title_changed_at"},
	{"task_session_pins", "requirement_id,session_id"},
	{"session_organization", "session_id,pinned,archived,updated_at"},
	{"conversation_input_requests", "session_id,request_id,fingerprint,status"},
	{"conversation_async_answers", "session_id,item_id,turn_id,fingerprint,status,request_id"},
	{"conversation_drafts", "key,payload,updated_at"},
	{"conversation_create_requests", "request_id,fingerprint,session_id"},
}

type MetadataSnapshot struct {
	Tables map[string][][]any `json:"tables"`
}

func ExportMetadata(ctx context.Context, file string) (MetadataSnapshot, error) {
	snapshot := MetadataSnapshot{Tables: map[string][][]any{}}
	if file == "" {
		file = filepath.Join(platform.DefaultDataDir(), "worktree-hub.db")
	}
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return snapshot, nil
	} else if err != nil {
		return snapshot, err
	}
	p := filepath.ToSlash(file)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	u := &url.URL{Scheme: "file", Path: p}
	db, err := sql.Open("sqlite", u.String()+"?mode=ro")
	if err != nil {
		return snapshot, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return snapshot, err
	}
	defer tx.Rollback()
	for _, table := range metadataTables {
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table.Name).Scan(&exists); err != nil {
			return snapshot, err
		}
		if exists == 0 {
			continue
		}
		selectColumns := table.Columns
		if table.Name == "requirements" {
			var columns int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('requirements') WHERE name='has_workspace'`).Scan(&columns); err != nil {
				return snapshot, err
			}
			if columns == 0 {
				selectColumns = "id,name,slug,description,branch,path,primary_project_id,state,created_at,1"
			}
		}
		if table.Name == "sessions" {
			var titleColumns int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('sessions') WHERE name='title_source'`).Scan(&titleColumns); err != nil {
				return snapshot, err
			}
			if titleColumns == 0 {
				selectColumns = "id,name,cwd,created_at,updated_at,source,last_synced_at,additional_directories,CASE WHEN name='' THEN '' ELSE 'legacy' END,0"
			}
		}
		if table.Name == "members" {
			// Export legacy databases without modifying the source environment.
			rows, err := tx.QueryContext(ctx, "SELECT * FROM members LIMIT 0")
			if err != nil {
				return snapshot, err
			}
			columns, err := rows.Columns()
			rows.Close()
			if err != nil {
				return snapshot, err
			}
			if len(columns) == 6 {
				selectColumns = "requirement_id,project_id,path,base_commit,state,error,'new','refs/heads/master',''"
			}
		}
		rows, err := tx.QueryContext(ctx, "SELECT "+selectColumns+" FROM "+table.Name)
		if err != nil {
			return snapshot, err
		}
		count := len(strings.Split(table.Columns, ","))
		for rows.Next() {
			values := make([]any, count)
			dest := make([]any, count)
			for i := range values {
				dest[i] = &values[i]
			}
			if err := rows.Scan(dest...); err != nil {
				rows.Close()
				return snapshot, err
			}
			for i, v := range values {
				if b, ok := v.([]byte); ok {
					values[i] = string(b)
				}
			}
			snapshot.Tables[table.Name] = append(snapshot.Tables[table.Name], values)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return snapshot, err
		}
	}
	return snapshot, tx.Commit()
}
func (s *Store) ImportMetadata(snapshot MetadataSnapshot) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, name := range []string{"projects", "requirements", "sessions"} {
		var count int
		if err := tx.QueryRow("SELECT count(*) FROM " + name).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("目标环境已有项目、任务或会话索引，不能覆盖导入")
		}
	}
	for _, table := range metadataTables {
		count := len(strings.Split(table.Columns, ","))
		placeholders := strings.TrimSuffix(strings.Repeat("?,", count), ",")
		for _, row := range snapshot.Tables[table.Name] {
			if table.Name == "requirements" && len(row) == 9 {
				row = append(append([]any{}, row...), int64(1))
			}
			if table.Name == "sessions" && len(row) == 8 {
				source := "legacy"
				if row[1] == "" {
					source = ""
				}
				row = append(append([]any{}, row...), source, int64(0))
			}
			if table.Name == "members" && len(row) == 6 {
				row = append(append([]any{}, row...), "new", "refs/heads/master", "")
			}
			if len(row) != count {
				return fmt.Errorf("导入数据结构不匹配：%s", table.Name)
			}
			if table.Name == "requirements" && row[6] == "" {
				row = append([]any{}, row...)
				row[6] = nil
			}
			if _, err := tx.Exec("INSERT INTO "+table.Name+"("+table.Columns+") VALUES("+placeholders+")", row...); err != nil {
				return fmt.Errorf("导入 %s 失败：%w", table.Name, err)
			}
		}
	}
	if _, err := tx.Exec(`UPDATE requirements SET state='partial' WHERE state='creating'; UPDATE members SET state='failed',error='导入时操作尚未完成，请检查后重试' WHERE state IN ('creating','pending')`); err != nil {
		return err
	}
	if _, err := tx.Exec(repairTaskPrimary); err != nil {
		return err
	}
	if err := backfillSessions(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE sessions SET title_source='legacy' WHERE name<>'' AND title_source=''`); err != nil {
		return err
	}
	return tx.Commit()
}
