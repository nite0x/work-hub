package platform

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWindowsEditorsUseTheRequestedWSLDirectory(t *testing.T) {
	path := "/home/user/workspaces/task/app with space"
	if got := windowsEditorArgs("vscode", path, "Ubuntu"); !reflect.DeepEqual(got, []string{"--new-window", "--folder-uri", "vscode-remote://wsl+Ubuntu/home/user/workspaces/task/app%20with%20space"}) {
		t.Fatal(got)
	}
	if got := windowsEditorArgs("idea", path, "Ubuntu"); !reflect.DeepEqual(got, []string{`\\wsl.localhost\Ubuntu\home\user\workspaces\task\app with space`}) {
		t.Fatal(got)
	}
	if got := windowsEditorArgs("vscode", `D:\projects\app with space`, ""); !reflect.DeepEqual(got, []string{"--new-window", `D:\projects\app with space`}) {
		t.Fatal(got)
	}
}

func TestWindowsEditorDiscoverySupportsStandardAndToolboxDirectories(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PATH", root)
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("ProgramFiles", filepath.Join(root, "program-files"))
	t.Setenv("ProgramFiles(x86)", filepath.Join(root, "program-files-x86"))
	for tool, relative := range map[string]string{
		"vscode": filepath.Join("Programs", "Microsoft VS Code", "Code.exe"),
		"idea":   filepath.Join("JetBrains", "Toolbox", "apps", "IDEA-U", "ch-0", "262.1", "bin", "idea64.exe"),
	} {
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0755); err != nil {
			t.Fatal(err)
		}
		got, err := windowsEditor(tool)
		if err != nil || got != path {
			t.Fatalf("%s: %q %v", tool, got, err)
		}
	}
}
