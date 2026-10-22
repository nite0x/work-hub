package model

type LaunchPlan struct {
	Tool                  string   `json:"tool,omitempty"`
	Title                 string   `json:"title"`
	Cwd                   string   `json:"cwd"`
	Args                  []string `json:"args"`
	Command               string   `json:"command"`
	AdditionalDirectories []string `json:"additional_directories"`
	Script                string   `json:"-"`
	Requirement           string   `json:"-"`
	Session               string   `json:"-"`
}
type TerminalAvailability struct {
	Platform  string           `json:"platform"`
	Kinds     []string         `json:"supported_kinds"`
	Styles    []string         `json:"supported_styles"`
	Settings  TerminalSettings `json:"settings"`
	Available bool             `json:"available"`
	Codex     bool             `json:"codex"`
	Launcher  string           `json:"launcher"`
	Distro    string           `json:"distro"`
	Message   string           `json:"message"`
}

type TerminalSettings struct {
	Kind  string `json:"kind"`
	Path  string `json:"path"`
	Style string `json:"style"`
}

func (s TerminalSettings) Label() string {
	switch s.Kind {
	case "macos-terminal":
		return " macOS Terminal "
	case "windows-terminal":
		return " Windows Terminal "
	case "otty":
		return " Otty "
	case "powershell":
		return " PowerShell "
	case "custom":
		return "自定义终端"
	default:
		return "系统终端"
	}
}
