package model

type Project struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Path            string     `json:"path"`
	CommonDir       string     `json:"common_dir"`
	Folder          string     `json:"folder"`
	CreatedAt       string     `json:"created_at"`
	HasMaster       bool       `json:"has_master"`
	Error           string     `json:"error,omitempty"`
	Worktrees       []Worktree `json:"worktrees"`
	StatusUpdatedAt string     `json:"status_updated_at,omitempty"`
	Refreshing      bool       `json:"refreshing"`
}
type Requirement struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Slug             string   `json:"slug"`
	Description      string   `json:"description"`
	Branch           string   `json:"branch"`
	Path             string   `json:"path"`
	PrimaryProjectID string   `json:"primary_project_id"`
	State            string   `json:"state"`
	CreatedAt        string   `json:"created_at"`
	Members          []Member `json:"members"`
}
type Member struct {
	ProjectID   string    `json:"project_id"`
	ProjectName string    `json:"project_name"`
	Path        string    `json:"path"`
	BaseCommit  string    `json:"base_commit"`
	BaseRef     string    `json:"base_ref"`
	Branch      string    `json:"branch"`
	Mode        string    `json:"mode"`
	State       string    `json:"state"`
	Error       string    `json:"error,omitempty"`
	Worktree    *Worktree `json:"worktree,omitempty"`
}

type Worktree struct {
	Path             string     `json:"path"`
	Branch           string     `json:"branch"`
	Head             string     `json:"head"`
	Bare             bool       `json:"bare"`
	Detached         bool       `json:"detached"`
	Locked           bool       `json:"locked"`
	Prunable         bool       `json:"prunable"`
	Missing          bool       `json:"missing"`
	Dirty            int        `json:"dirty"`
	Ahead            int        `json:"ahead"`
	Behind           int        `json:"behind"`
	CompareAvailable bool       `json:"compare_available"`
	ComparisonRef    string     `json:"comparison_ref,omitempty"`
	Upstream         string     `json:"upstream,omitempty"`
	SyncAvailable    bool       `json:"sync_available"`
	SyncAhead        int        `json:"sync_ahead"`
	SyncBehind       int        `json:"sync_behind"`
	Operation        string     `json:"operation,omitempty"`
	MergeHead        string     `json:"merge_head,omitempty"`
	Conflicts        []string   `json:"conflicts,omitempty"`
	Error            string     `json:"error,omitempty"`
	RequirementID    string     `json:"requirement_id,omitempty"`
	RequirementName  string     `json:"requirement_name,omitempty"`
	Requirements     []TaskLink `json:"requirements,omitempty"`
	ExpectedBranch   string     `json:"expected_branch,omitempty"`
	StatusUpdatedAt  string     `json:"status_updated_at,omitempty"`
	Refreshing       bool       `json:"refreshing"`
}

type TaskLink struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
