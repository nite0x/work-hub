package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"worktree-hub/internal/model"
)

func Availability(settings model.TerminalSettings) model.TerminalAvailability {
	v := terminalPlatformInfo(settings)
	_, err := exec.LookPath("codex")
	v.Codex = err == nil
	v.Launcher, err = ResolveTerminal(settings)
	v.Available = v.Launcher != ""
	if err != nil {
		v.Message = err.Error()
	} else if !v.Codex {
		v.Message = "终端可用；未找到 Codex CLI，可继续使用 Git 终端，安装 Codex 后可在终端对话"
	} else {
		v.Message = "将使用" + settings.Label() + "打开独立终端；首次使用 Codex 时可能需要登录"
	}
	return v
}

func terminalPlatformInfo(settings model.TerminalSettings) model.TerminalAvailability {
	v := model.TerminalAvailability{Settings: settings, Distro: os.Getenv("WSL_DISTRO_NAME"), Platform: runtime.GOOS}
	v.Kinds, v.Styles = terminalChoices(runtime.GOOS, v.Distro != "")
	return v
}
func (a *Service) LaunchTerminal(p model.LaunchPlan, onFailure func()) error {
	settings, err := a.TerminalSettings()
	if err != nil {
		return err
	}
	return a.StartTerminal(settings, p, onFailure)
}

func (a *Service) StartTerminal(settings model.TerminalSettings, p model.LaunchPlan, onFailure func()) error {
	launcher, err := ResolveTerminal(settings)
	if err != nil {
		return err
	}
	cmd, err := TerminalCommand(settings, launcher, os.Getenv("WSL_DISTRO_NAME"), p)
	if err != nil {
		return err
	}
	if settings.Kind == "otty" || (settings.Kind == "custom" && settings.Style == "otty") {
		return LaunchOtty(launcher, cmd.Args[1:], p.Cwd)
	}
	cmd.Dir = p.Cwd
	if usesMacTerminal(settings) {
		// open exits after LaunchServices accepts the document. Wait for that
		// result so a missing app or denied launch is reported to the caller.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		request := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
		request.Dir = p.Cwd
		if output, err := request.CombinedOutput(); err != nil {
			return fmt.Errorf("无法打开 macOS Terminal：%s（%v）", strings.TrimSpace(string(output)), err)
		}
		return nil
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法打开终端：%w", err)
	}
	go func() {
		if err := cmd.Wait(); err != nil && len(p.Args) > 0 {
			if onFailure != nil {
				onFailure()
			}
		}
	}()
	return nil
}
