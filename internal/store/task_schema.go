package store

import "fmt"

// A launch preference is optional and must always refer to a current member.
const repairTaskPrimary = `UPDATE requirements SET primary_project_id=(
 SELECT project_id FROM members WHERE requirement_id=requirements.id ORDER BY project_id LIMIT 1
) WHERE primary_project_id IS NULL OR NOT EXISTS (
 SELECT 1 FROM members WHERE requirement_id=requirements.id AND project_id=primary_project_id
)`

func (s *Store) finishTaskMigration() error {
	var required int
	if err := s.DB.QueryRow(`SELECT "notnull" FROM pragma_table_info('requirements') WHERE name='primary_project_id'`).Scan(&required); err != nil {
		return err
	}
	if required != 0 {
		// Rebuild the parent under the same name; dependent tables, task IDs and
		// saved workspace paths are preserved. Foreign keys are restored on error.
		if _, err := s.DB.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
			return err
		}
		err := s.makeTaskPrimaryOptional()
		_, restoreErr := s.DB.Exec(`PRAGMA foreign_keys=ON`)
		if err != nil {
			return err
		}
		if restoreErr != nil {
			return restoreErr
		}
	}
	if _, err := s.DB.Exec(repairTaskPrimary); err != nil {
		return err
	}
	return s.migrateSessions()
}

func (s *Store) makeTaskPrimaryOptional() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE requirements_optional (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
 description TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
 primary_project_id TEXT REFERENCES projects(id), state TEXT NOT NULL,
 created_at TEXT NOT NULL, has_workspace INTEGER NOT NULL DEFAULT 1);
INSERT INTO requirements_optional SELECT id,name,slug,description,branch,path,primary_project_id,state,created_at,has_workspace FROM requirements;
DROP TABLE requirements;
ALTER TABLE requirements_optional RENAME TO requirements;`)
	if err != nil {
		return fmt.Errorf("迁移任务启动偏好失败：%w", err)
	}
	if _, err := tx.Exec(repairTaskPrimary); err != nil {
		return err
	}
	return tx.Commit()
}
