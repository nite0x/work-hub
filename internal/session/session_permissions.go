package session

// A permissions change is explicit and applies at a turn boundary. Empty means
// inherit the native session; it must never silently widen its permissions.
func setThreadPermissions(params map[string]any, permission string) {
	if permission == "" { permission = "ask" }
	params["sandbox"] = "workspace-write"
	params["approvalPolicy"] = "on-request"
	params["approvalsReviewer"] = "user"
	if permission == "auto" { params["approvalsReviewer"] = "auto_review" }
	if permission == "full" {
		params["sandbox"] = "danger-full-access"
		params["approvalPolicy"] = "never"
	}
}

func setTurnPermissions(params map[string]any, permission string, roots []string) {
	if permission == "" { return }
	config := map[string]any{}
	setThreadPermissions(config, permission)
	params["approvalPolicy"] = config["approvalPolicy"]
	params["approvalsReviewer"] = config["approvalsReviewer"]
	if permission == "full" {
		params["sandboxPolicy"] = map[string]any{"type": "dangerFullAccess"}
	} else {
		params["sandboxPolicy"] = map[string]any{"type": "workspaceWrite", "writableRoots": roots, "networkAccess": false}
	}
}
