package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func syncTime(day, clock string) time.Time {
	v, err := time.Parse(time.RFC3339, day+"T"+clock+":00+08:00")
	if err != nil {
		panic(err)
	}
	return v
}

func syncClone(t *testing.T) (seed, remote, clone string) {
	t.Helper()
	seed, remote, clone = remoteClone(t)
	// Deliberately keep the narrow single-branch fetch configuration, with no master upstream.
	testGit(t, clone, "branch", "master", "HEAD")
	return
}

func dailySync(t *testing.T, a *App, at time.Time) *MasterSyncRun {
	t.Helper()
	if err := a.runDailyMasterSync(context.Background(), at); err != nil {
		t.Fatal(err)
	}
	v, err := a.masterSyncState(at)
	if err != nil {
		t.Fatal(err)
	}
	return v.LastRun
}

func reopenSyncApp(t *testing.T, a *App) *App {
	t.Helper()
	reopened, err := openApp(a.dataDir, a.root)
	if err != nil {
		t.Fatal(err)
	}
	reopened.credentialHelper = ""
	t.Cleanup(func() { reopened.stateCache.close(); reopened.db.Close() })
	return reopened
}

func TestDailyMasterSyncScheduleCatchupRestartAndTaskBaseline(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := syncClone(t)
	id := register(t, a, "Project", clone)
	featureHead := testGit(t, clone, "rev-parse", "HEAD")
	sentinel := filepath.Join(clone, "unsaved.txt")
	_ = os.WriteFile(sentinel, []byte("keep feature edits"), 0644)
	advanceRemote(t, seed, remote, "daily.txt")
	if got := dailySync(t, a, syncTime("2026-10-22", "08:59")); got != nil {
		t.Fatal("ran before 09:00 Beijing time")
	}
	// The host clock is UTC; the trigger must still use Shanghai time.
	at := syncTime("2026-10-22", "09:00").UTC()
	run := dailySync(t, a, at)
	if run.Status != "completed" || len(run.Results) != 1 || run.Results[0].Status != "updated" {
		t.Fatalf("unexpected run: %+v", run)
	}
	firstMaster := testGit(t, seed, "rev-parse", "master")
	if testGit(t, clone, "rev-parse", "master") != firstMaster || testGit(t, clone, "rev-parse", "HEAD") != featureHead {
		t.Fatal("wrong ref advanced")
	}
	if data, _ := os.ReadFile(sentinel); string(data) != "keep feature edits" {
		t.Fatal("feature edits changed")
	}
	if code, q, raw := create(t, a, id, nil, "fresh-baseline"); code != 201 || q.Members[0].BaseCommit != firstMaster {
		t.Fatalf("new task did not use updated master: %d %s", code, raw)
	}
	advanceRemote(t, seed, remote, "tomorrow.txt")
	reopened := reopenSyncApp(t, a)
	if next := dailySync(t, reopened, syncTime("2026-10-22", "23:59")); next.StartedAt != run.StartedAt {
		t.Fatal("same day replayed after restart")
	}
	if testGit(t, clone, "rev-parse", "master") != firstMaster {
		t.Fatal("same day ref changed")
	}
	// Startup after the deadline catches up once for today, without replaying missed days.
	run = dailySync(t, reopened, syncTime("2026-10-25", "14:30"))
	if run.Date != "2026-10-25" || run.Results[0].Status != "updated" || testGit(t, clone, "rev-parse", "master") != testGit(t, seed, "rev-parse", "master") {
		t.Fatalf("catchup failed: %+v", run)
	}
	v, err := reopened.masterSyncState(syncTime("2026-10-25", "15:00"))
	if err != nil || v.NextRun != "2026-10-26T09:00:00+08:00" {
		t.Fatalf("wrong next run: %+v %v", v, err)
	}
}

func TestDailyMasterSyncCheckedOutMasterProtectsWorkAndUpdatesFiles(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := syncClone(t)
	register(t, a, "Checked out", clone)
	masterPath := filepath.Join(t.TempDir(), "master-tree")
	testGit(t, clone, "worktree", "add", masterPath, "master")
	before := testGit(t, clone, "rev-parse", "master")
	advanceRemote(t, seed, remote, "new-file.txt")
	_ = os.WriteFile(filepath.Join(masterPath, "README.md"), []byte("uncommitted"), 0644)
	run := dailySync(t, a, syncTime("2026-10-22", "09:00"))
	if run.Results[0].Status != "skipped" || testGit(t, clone, "rev-parse", "master") != before {
		t.Fatalf("dirty master changed: %+v", run)
	}
	if content, _ := os.ReadFile(filepath.Join(masterPath, "README.md")); string(content) != "uncommitted" {
		t.Fatal("dirty file changed")
	}
	testGit(t, masterPath, "restore", "README.md")
	run = dailySync(t, a, syncTime("2026-10-23", "09:00"))
	if run.Results[0].Status != "updated" || testGit(t, masterPath, "rev-parse", "HEAD") != testGit(t, seed, "rev-parse", "master") {
		t.Fatalf("clean master not advanced: %+v", run)
	}
	if _, err := os.Stat(filepath.Join(masterPath, "new-file.txt")); err != nil {
		t.Fatal("master worktree files not updated")
	}
	if testGit(t, clone, "branch", "--show-current") != "codex/wsl-startup" {
		t.Fatal("registered checkout switched branches")
	}
}

func TestDailyMasterSyncContinuesAfterFailuresAndNeverFallsBackToMain(t *testing.T) {
	a := testApp(t)
	bad := repo(t, "auth", "master")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="daily test"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	t.Setenv("GIT_ASKPASS", "/bin/false")
	testGit(t, bad, "config", "credential.helper", "")
	testGit(t, bad, "remote", "add", "origin", server.URL+"/repo.git")
	badID := register(t, a, "Auth", bad)
	noMaster := repo(t, "main-only", "main")
	mainID := register(t, a, "Main only", noMaster)
	seed, remote, clone := syncClone(t)
	goodID := register(t, a, "Good", clone)
	advanceRemote(t, seed, remote, "good.txt")
	run := dailySync(t, a, syncTime("2026-10-22", "09:00"))
	statuses := map[string]string{}
	for _, result := range run.Results {
		statuses[result.ProjectID] = result.Status
	}
	if statuses[badID] != "failed" || statuses[mainID] != "skipped" || statuses[goodID] != "updated" {
		t.Fatalf("bad per-project results: %+v", run)
	}
	if testGit(t, noMaster, "branch", "--show-current") != "main" {
		t.Fatal("main-only repo altered")
	}
	if _, err := git(context.Background(), noMaster, "rev-parse", "--verify", "refs/heads/master"); err == nil {
		t.Fatal("unexpected fallback to main")
	}
}

func TestDailyMasterSyncRefusesUnsafeMasterUpdates(t *testing.T) {
	for _, mode := range []string{"divergent", "wrong-upstream", "locked", "rebase", "duplicate-checkout", "remote-deleted"} {
		t.Run(mode, func(t *testing.T) {
			a := testApp(t)
			seed, remote, clone := syncClone(t)
			id := register(t, a, mode, clone)
			switch mode {
			case "divergent":
				testGit(t, clone, "switch", "master")
				_ = os.WriteFile(filepath.Join(clone, "local.txt"), []byte("local"), 0644)
				testGit(t, clone, "add", "local.txt")
				testGit(t, clone, "commit", "-m", "local commit")
				testGit(t, clone, "switch", "codex/wsl-startup")
			case "wrong-upstream":
				testGit(t, clone, "config", "branch.master.remote", "origin")
				testGit(t, clone, "config", "branch.master.merge", "refs/heads/main")
			case "locked":
				path := filepath.Join(t.TempDir(), "locked-master")
				testGit(t, clone, "worktree", "add", path, "master")
				testGit(t, clone, "worktree", "lock", path)
			case "rebase":
				testGit(t, clone, "switch", "master")
				path := testGit(t, clone, "rev-parse", "--git-path", "rebase-merge")
				if !filepath.IsAbs(path) {
					path = filepath.Join(clone, path)
				}
				if err := os.MkdirAll(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "duplicate-checkout":
				testGit(t, clone, "switch", "master")
				testGit(t, clone, "worktree", "add", "--force", filepath.Join(t.TempDir(), "duplicate"), "master")
			case "remote-deleted":
				testGit(t, remote, "update-ref", "-d", "refs/heads/master")
			}
			before := testGit(t, clone, "rev-parse", "master")
			if mode != "remote-deleted" {
				advanceRemote(t, seed, remote, "remote-change.txt")
			}
			status, message, err := a.syncProjectMaster(context.Background(), id)
			if mode == "remote-deleted" {
				if err == nil {
					t.Fatal("deleted remote master accepted")
				}
			} else if err != nil || status != "skipped" {
				t.Fatalf("unsafe master accepted: %s %s %v", status, message, err)
			}
			if testGit(t, clone, "rev-parse", "master") != before {
				t.Fatal("unsafe update altered master")
			}
		})
	}
}

func TestDailyMasterSyncSettingsAndInterruptedRunPersist(t *testing.T) {
	a := testApp(t)
	for _, clock := range []string{"9:00", "24:00", "09:60", "", "09:00:00"} {
		if code, _ := call(t, a, "PUT", "/api/settings/master-sync", MasterSyncSettings{Enabled: true, Time: clock}); code != 400 {
			t.Fatalf("invalid time accepted: %q", clock)
		}
	}
	register(t, a, "Local", repo(t, "local", "master"))
	if code, raw := call(t, a, "PUT", "/api/settings/master-sync", MasterSyncSettings{Time: "08:00"}); code != 200 {
		t.Fatalf("settings failed: %d %s", code, raw)
	}
	reopened := reopenSyncApp(t, a)
	if run := dailySync(t, reopened, syncTime("2026-10-22", "10:00")); run != nil {
		t.Fatal("disabled setting ignored after restart")
	}
	s, _ := reopened.masterSyncSettings()
	if s.Time != "08:00" || s.Enabled {
		t.Fatalf("settings not persisted: %+v", s)
	}
	if code, _ := call(t, reopened, "PUT", "/api/settings/master-sync", MasterSyncSettings{Enabled: true, Time: "08:00"}); code != 200 {
		t.Fatal("enable failed")
	}
	_, err := reopened.db.Exec(`INSERT INTO master_sync_runs(date,started_at,finished_at,status,results) VALUES('2026-10-22',?,'','running','[]')`, now())
	if err != nil {
		t.Fatal(err)
	}
	restarted := reopenSyncApp(t, reopened)
	run := dailySync(t, restarted, syncTime("2026-10-22", "10:00"))
	if run.Status != "interrupted" {
		t.Fatalf("interrupted run replayed: %+v", run)
	}
	code, raw := call(t, restarted, "GET", "/api/state", nil)
	var state struct {
		MasterSync MasterSyncState `json:"master_sync"`
	}
	if err := json.Unmarshal(raw, &state); err != nil || code != 200 || state.MasterSync.Timezone != masterSyncTimezone || state.MasterSync.LastRun.Status != "interrupted" {
		t.Fatalf("state missing persisted result: %d %s %v", code, raw, err)
	}
}

func TestDailyMasterSyncUsesConfiguredRemoteAndStopsWithService(t *testing.T) {
	a := testApp(t)
	seed, remote, clone := syncClone(t)
	id := register(t, a, "Renamed remote", clone)
	testGit(t, clone, "remote", "rename", "origin", "upstream")
	testGit(t, clone, "config", "branch.master.remote", "upstream")
	testGit(t, clone, "config", "branch.master.merge", "refs/heads/master")
	advanceRemote(t, seed, remote, "upstream.txt")
	status, message, err := a.syncProjectMaster(context.Background(), id)
	if err != nil || status != "updated" || !strings.Contains(message, "upstream/master") {
		t.Fatalf("configured remote ignored: %s %s %v", status, message, err)
	}
	status, _, err = a.syncProjectMaster(context.Background(), id)
	if err != nil || status != "current" {
		t.Fatalf("current branch not recognized: %s %v", status, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stop := a.startMasterSync(ctx)
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop with service")
	}
}
