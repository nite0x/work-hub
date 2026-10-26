package session

import (
	"os"
	"reflect"
	"testing"
)

func TestTaskConversationCreationAllowsChangedCheckout(t *testing.T) {
	for _, checkout := range []string{"branch", "detached"} {
		for _, directory := range []string{"member", "workspace"} {
			t.Run(checkout+"/"+directory, func(t *testing.T) {
				a, q, c, _ := chatFixture(t)
				member := q.Members[0]
				if checkout == "branch" {
					testGit(t, member.Path, "checkout", "-b", "user-branch")
				} else {
					testGit(t, member.Path, "checkout", "--detach", "HEAD")
				}
				before := testGit(t, member.Path, "rev-parse", "--abbrev-ref", "HEAD")
				cwd := member.Path
				additional := []string{}
				if directory == "workspace" {
					cwd = q.Path
					additional = []string{member.Path}
				}
				c.cwd = cwd
				code, raw := call(t, a, "POST", "/api/sessions/new", map[string]any{
					"task_id": q.ID, "cwd": cwd, "text": "继续当前工作", "request_id": "changed-checkout",
				})
				if code != 202 {
					t.Fatalf("create after checkout: %d %s", code, raw)
				}
				awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
				saved, err := a.Workspace.Store.Session("session")
				if err != nil || saved.Cwd != cwd || !reflect.DeepEqual(saved.AdditionalDirectories, additional) {
					t.Fatalf("execution directories: %+v %v", saved, err)
				}
				if after := testGit(t, member.Path, "rev-parse", "--abbrev-ref", "HEAD"); after != before {
					t.Fatalf("creation changed checkout: %s -> %s", before, after)
				}
				current, err := a.Workspace.Store.Requirement(q.ID)
				if err != nil || current.Branch != q.Branch || current.Members[0].Branch != member.Branch {
					t.Fatalf("creation changed task branch metadata: %+v %v", current, err)
				}
				c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
				awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			})
		}
	}
}

func TestTaskConversationCreationRejectsUnavailableOrReplacedRepository(t *testing.T) {
	for _, replacement := range []string{"missing", "foreign"} {
		t.Run(replacement, func(t *testing.T) {
			a, q, c, _ := chatFixture(t)
			cwd := q.Members[0].Path
			if err := os.Rename(cwd, cwd+"-original"); err != nil {
				t.Fatal(err)
			}
			if replacement == "foreign" {
				if err := os.Rename(repo(t, "foreign", "master"), cwd); err != nil {
					t.Fatal(err)
				}
			}
			if code, raw := call(t, a, "POST", "/api/sessions/new", map[string]string{
				"task_id": q.ID, "cwd": cwd, "text": "继续当前工作", "request_id": "invalid-checkout",
			}); code != 409 {
				t.Fatalf("invalid checkout accepted: %d %s", code, raw)
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if len(c.methods) != 0 {
				t.Fatal("invalid checkout reached Codex", c.methods)
			}
		})
	}
}
