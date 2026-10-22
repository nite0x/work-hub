package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Fixture secrets exist only in the isolated test helper, never in the user's
// OS store. Exercise Git's real credential protocol and HTTP transport.
func fixtureCredentialHelper(t *testing.T) (helper, store string) {
	t.Helper()
	root := t.TempDir()
	store = filepath.Join(root, "fixture-credentials")
	script := filepath.Join(root, "fixture helper.py")
	source := `#!/usr/bin/python3
import os, sys
fields = dict(line.rstrip('\n').split('=', 1) for line in sys.stdin if '=' in line)
path = ` + fmt.Sprintf("%q", store) + `
if sys.argv[1] == 'store':
    with open(path, 'w') as out:
        os.chmod(path, 0o600)
        out.write('username=' + fields.get('username', '') + '\npassword=' + fields.get('password', '') + '\n')
elif sys.argv[1] == 'get' and os.path.exists(path):
    with open(path) as saved:
        sys.stdout.write(saved.read())
elif sys.argv[1] == 'erase' and os.path.exists(path):
    os.remove(path)
`
	if err := os.WriteFile(script, []byte(source), 0700); err != nil {
		t.Fatal(err)
	}
	return "!" + shellQuote(script), store
}

func TestTerminalLoginReusedByBackgroundFetchPullAndReopen(t *testing.T) {
	a := testApp(t)
	helper, store := fixtureCredentialHelper(t)
	a.credentialHelper = helper
	seed, remote, clone := remoteClone(t)
	gitExec := testGit(t, clone, "--exec-path")
	backend := &cgi.Handler{Path: filepath.Join(gitExec, "git-http-backend"), Env: []string{"GIT_PROJECT_ROOT=" + filepath.Dir(remote), "GIT_HTTP_EXPORT_ALL=1"}}
	const username, password = "fixture-user", "fixture-test-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != username || p != password {
			w.Header().Set("WWW-Authenticate", `Basic realm="Worktree Hub fixture"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	defer server.Close()
	testGit(t, clone, "remote", "set-url", "origin", server.URL+"/origin.git")
	// Clear inherited test-machine helpers before the app appends its helper.
	testGit(t, clone, "config", "credential.helper", "")
	id := register(t, a, "Auth fixture", clone)
	t.Setenv("GIT_ASKPASS", "/bin/false")
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 409 || !strings.Contains(string(raw), "authentication_required") {
		t.Fatalf("first fetch should need login: %d %s", code, raw)
	}
	// Simulate the user typing fixture credentials only during terminal login.
	askpass := filepath.Join(t.TempDir(), "askpass.sh")
	if err := os.WriteFile(askpass, []byte("#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' '"+username+"';; *) printf '%s\\n' '"+password+"';; esac\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_ASKPASS", askpass)
	var plan LaunchPlan
	a.launch = func(p LaunchPlan) error { plan = p; return nil }
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch_terminal", Remote: "origin"}); code != 200 {
		t.Fatalf("terminal login failed: %d %s", code, raw)
	}
	if script, err := os.ReadFile(plan.Script); err != nil || strings.Contains(string(script), password) || strings.Contains(plan.Command, password) {
		t.Fatal("credential leaked to terminal script or command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", plan.Script)
	cmd.Stdin = strings.NewReader("exit\n")
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "获取完成") || strings.Contains(string(output), password) {
		t.Fatal("terminal authentication did not finish cleanly")
	}
	if _, err := os.Stat(store); err != nil {
		t.Fatal("terminal did not approve credentials to shared helper")
	}
	t.Setenv("GIT_ASKPASS", "/bin/false")
	advanceRemote(t, seed, remote, "after-login.txt")
	for i := 0; i < 2; i++ {
		if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 || strings.Contains(string(raw), password) {
			t.Fatal("background fetch did not reuse credentials")
		}
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "create_branch", Name: "master", Source: "refs/remotes/origin/master", Track: true}); code != 200 {
		t.Fatalf("prepare master: %d %s", code, raw)
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "switch", Source: "refs/heads/master", Path: clone}); code != 200 {
		t.Fatalf("switch to master: %d %s", code, raw)
	}
	advanceRemote(t, seed, remote, "background-pull.txt")
	if code, raw := gitAction(t, a, id, GitAction{Action: "pull", Path: clone}); code != 200 || strings.Contains(string(raw), password) {
		t.Fatal("background pull did not reuse credentials")
	}
	if testGit(t, clone, "rev-parse", "HEAD") != testGit(t, seed, "rev-parse", "HEAD") {
		t.Fatal("authenticated pull did not update checkout")
	}
	reopened, err := openApp(a.dataDir, a.root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	reopened.credentialHelper = helper
	if code, raw := gitAction(t, reopened, id, GitAction{Action: "fetch", Remote: "origin"}); code != 200 || strings.Contains(string(raw), password) {
		t.Fatal("reopened service did not reuse credentials")
	}
	// Revoked credentials are erased by Git, and the UI asks for login again.
	if err := os.WriteFile(store, []byte("username=fixture-user\npassword=revoked\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if code, raw := gitAction(t, a, id, GitAction{Action: "fetch", Remote: "origin"}); code != 409 || !strings.Contains(string(raw), "authentication_required") {
		t.Fatalf("invalid credentials were not reported: %d %s", code, raw)
	}
	if _, err := os.Stat(store); !os.IsNotExist(err) {
		t.Fatal("rejected credentials were not erased")
	}
	if got := testGit(t, clone, "config", "--get-all", "credential.helper"); got != "" {
		t.Fatal("application modified repository credential configuration")
	}
}

func TestCredentialBridgeProtocolAndInteropEnvironment(t *testing.T) {
	root := t.TempDir()
	manager := filepath.Join(root, "fake-manager")
	// Never touch the real Windows store. Verify environment forwarding and
	// protocol bytes using a simulated executable.
	script := `#!/usr/bin/python3
import os, sys
assert os.environ['GCM_INTERACTIVE'] == 'false'
assert os.environ['GCM_TRACE_SECRETS'] == 'false'
assert os.environ['GCM_TRACE'] == 'false'
assert os.environ['GCM_PROVIDER'] == 'generic'
assert os.environ['GCM_ALLOW_UNSAFE_REMOTES'] == 'true'
assert 'GCM_INTERACTIVE' in os.environ['WSLENV'].split(':')
assert 'EXISTING/p' in os.environ['WSLENV'].split(':')
assert sys.argv[1] in ['get', 'store', 'erase']
assert sys.stdin.read() == 'protocol=http\nhost=example.invalid\n\n'
if sys.argv[1] == 'get':
    print('username=fixture')
    print('password=fixture-secret')
`
	if err := os.WriteFile(manager, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WSLENV", "EXISTING/p")
	t.Setenv("GCM_TRACE_SECRETS", "true")
	for _, operation := range []string{"get", "store", "erase"} {
		var out, diagnostic bytes.Buffer
		if err := credentialBridge(manager, operation, strings.NewReader("protocol=http\nhost=example.invalid\n\n"), &out, &diagnostic); err != nil {
			t.Fatal("credential protocol bridge failed", operation)
		}
		if diagnostic.Len() != 0 || (operation == "get" && !strings.Contains(out.String(), "password=")) || (operation != "get" && out.Len() != 0) {
			t.Fatal("incorrect protocol response or diagnostic output")
		}
	}
	var out bytes.Buffer
	if err := credentialBridge(manager, "invalid", strings.NewReader(""), &out, &out); err == nil {
		t.Fatal("invalid operation accepted")
	}
	if err := credentialBridge(manager, "get", strings.NewReader("protocol=ssh\n\n"), &out, &out); err != nil || out.Len() != 0 {
		t.Fatal("SSH should be left to existing key configuration")
	}
	env := strings.Join(credentialBridgeEnv([]string{"WSLENV=EXISTING/p", "GCM_INTERACTIVE=true"}, "https"), "\n")
	if strings.Contains(env, "GCM_ALLOW_UNSAFE_REMOTES=true") || strings.Contains(env, "GCM_INTERACTIVE=true") {
		t.Fatal("HTTP-only configuration leaked to HTTPS or prompt suppression failed")
	}
}
