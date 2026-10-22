package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Explicit columns make import independent of platform and future additive
// schema migrations. No SQL identifiers supplied by a client are executed.
var metadataTables = []struct{ Name, Columns string }{
	{"projects", "id,name,path,common_dir,folder,created_at"},
	{"settings", "key,value"},
	{"master_sync_runs", "date,started_at,finished_at,status,results"},
	{"requirements", "id,name,slug,description,branch,path,primary_project_id,state,created_at"},
	{"members", "requirement_id,project_id,path,base_commit,state,error"},
	{"requirement_sessions", "requirement_id,session_id,name,cwd,created_at,updated_at,source"},
	{"session_create_requests", "requirement_id,request_id,session_id"},
}

type metadataSnapshot struct {
	Tables map[string][][]any `json:"tables"`
}

func exportMetadata(ctx context.Context, file string) (metadataSnapshot, error) {
	snapshot := metadataSnapshot{Tables: map[string][][]any{}}
	if file == "" {
		file = filepath.Join(defaultDataDir(), "worktree-hub.db")
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
		rows, err := tx.QueryContext(ctx, "SELECT "+table.Columns+" FROM "+table.Name)
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
func (a *App) importMetadata(snapshot metadataSnapshot) error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, name := range []string{"projects", "requirements"} {
		var count int
		if err := tx.QueryRow("SELECT count(*) FROM " + name).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("目标环境已有项目或任务，不能覆盖导入")
		}
	}
	for _, table := range metadataTables {
		count := len(strings.Split(table.Columns, ","))
		placeholders := strings.TrimSuffix(strings.Repeat("?,", count), ",")
		for _, row := range snapshot.Tables[table.Name] {
			if len(row) != count {
				return fmt.Errorf("导入数据结构不匹配：%s", table.Name)
			}
			if _, err := tx.Exec("INSERT INTO "+table.Name+"("+table.Columns+") VALUES("+placeholders+")", row...); err != nil {
				return fmt.Errorf("导入 %s 失败：%w", table.Name, err)
			}
		}
	}
	if _, err := tx.Exec(`UPDATE requirements SET state='partial' WHERE state='creating'; UPDATE members SET state='failed',error='导入时操作尚未完成，请检查后重试' WHERE state='creating'; UPDATE master_sync_runs SET status='interrupted' WHERE status='running'`); err != nil {
		return err
	}
	return tx.Commit()
}
