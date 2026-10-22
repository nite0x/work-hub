package model

type MasterSyncSettings struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time"`
}

type MasterSyncResult struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	Status      string `json:"status"`
	Message     string `json:"message"`
}

type MasterSyncRun struct {
	Date       string             `json:"date"`
	StartedAt  string             `json:"started_at"`
	FinishedAt string             `json:"finished_at"`
	Status     string             `json:"status"`
	Results    []MasterSyncResult `json:"results"`
}

type MasterSyncState struct {
	Settings MasterSyncSettings `json:"settings"`
	Timezone string             `json:"timezone"`
	NextRun  string             `json:"next_run,omitempty"`
	LastRun  *MasterSyncRun     `json:"last_run"`
}
