package model

// Session is an environment-local index of a Codex thread. It has no task or
// project owner; directory scopes determine where it is displayed. Each runtime
// environment already has its own Store, so IDs and paths never cross environments.
type Session struct {
	Pinned                bool     `json:"pinned"`
	Archived              bool     `json:"archived"`
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	TitleSource           string   `json:"title_source,omitempty"`
	TitleChangedAt        int64    `json:"-"`
	Cwd                   string   `json:"cwd"`
	CreatedAt             int64    `json:"created_at"`
	UpdatedAt             int64    `json:"updated_at"`
	Source                string   `json:"source"`
	LastSyncedAt          int64    `json:"last_synced_at"`
	AdditionalDirectories []string `json:"additional_directories,omitempty"`
	Available             bool     `json:"available"`
	Error                 string   `json:"error,omitempty"`
	ChatStatus            string   `json:"chat_status,omitempty"`
	CompletedRun          string   `json:"completed_run,omitempty"`
}
