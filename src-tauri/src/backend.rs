use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf, process::Command};

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Options {
    pub data: Option<PathBuf>,
    pub root: Option<PathBuf>,
    pub stop: bool,
    pub backend_info: bool,
}

impl Options {
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        Self::parse_at(args, std::env::current_dir().map_err(|e| e.to_string())?)
    }

    pub fn parse_at(
        args: impl IntoIterator<Item = OsString>,
        cwd: PathBuf,
    ) -> Result<Self, String> {
        let mut options = Self::default();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.to_str() {
                Some("--data") | Some("--root") => {
                    let value = args.next().ok_or("--data 和 --root 后需要目录路径")?;
                    if value.is_empty() {
                        return Err("目录路径不能为空".into());
                    }
                    let path = PathBuf::from(value);
                    let absolute = if path.is_absolute() {
                        path
                    } else {
                        cwd.join(path)
                    };
                    if arg == "--data" {
                        options.data = Some(absolute);
                    } else {
                        options.root = Some(absolute);
                    }
                }
                Some("--stop") => options.stop = true,
                Some("--backend-info") => options.backend_info = true,
                _ => return Err(format!("不支持的启动参数：{}", arg.to_string_lossy())),
            }
        }
        Ok(options)
    }

    pub fn command(&self, binary: &PathBuf, stop: bool) -> Command {
        let mut command = Command::new(binary);
        command.arg(if stop { "--stop" } else { "--desktop-start" });
        if let Some(data) = &self.data {
            command.arg("--data").arg(data);
        }
        if !stop {
            if let Some(root) = &self.root {
                command.arg("--root").arg(root);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW for the short-lived launcher only.
        }
        command
    }
}

#[derive(Clone, Deserialize, Serialize, Debug)]
pub struct Service {
    pub url: String,
    pub pid: u32,
    pub protocol: u32,
    pub version: String,
    pub data_dir: PathBuf,
    pub root: PathBuf,
    pub read_only_sessions: bool,
    pub ready: bool,
}

pub fn binary_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("无法确定桌面程序目录")?;
    let path = directory.join(if cfg!(windows) {
        "work-hub-backend.exe"
    } else {
        "work-hub-backend"
    });
    if !path.is_file() {
        return Err(format!("未找到随应用提供的 Go 后台：{}", path.display()));
    }
    Ok(path)
}

pub fn start(
    binary: &PathBuf,
    options: &Options,
    agent: Option<&PathBuf>,
) -> Result<Service, String> {
    let mut command = options.command(binary, false);
    if let Some(agent) = agent {
        command.env("WORKTREE_HUB_AGENT", agent);
    }
    let output = command
        .output()
        .map_err(|e| format!("无法启动本机后台：{e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let service: Service =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("无法读取后台启动信息：{e}"))?;
    let url = tauri::Url::parse(&service.url).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || service.protocol != 1
        || service.version != env!("WORK_HUB_BACKEND_VERSION")
        || !service.ready
        || !service.read_only_sessions
    {
        return Err("后台版本或启动信息不兼容，请安全停止旧后台后重新打开".into());
    }
    Ok(service)
}

pub fn stop(binary: &PathBuf, options: &Options) -> Result<(), String> {
    let output = options
        .command(binary, true)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_remain_separate_arguments() {
        let data = std::env::temp_dir().join("中文 ' & $data");
        let root = std::env::temp_dir().join("work spaces");
        let options = Options::parse([
            OsString::from("--data"),
            data.clone().into_os_string(),
            OsString::from("--root"),
            root.clone().into_os_string(),
        ])
        .unwrap();
        let command = options.command(&PathBuf::from("backend"), false);
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--desktop-start".to_owned(),
                "--data".to_owned(),
                data.to_string_lossy().into_owned(),
                "--root".to_owned(),
                root.to_string_lossy().into_owned()
            ]
        );
        let stop = options.command(&PathBuf::from("backend"), true);
        assert_eq!(stop.get_args().count(), 3); // stop targets data, never a different root.
    }

    #[test]
    fn rejects_unknown_or_missing_options() {
        assert!(Options::parse(["--root"].map(OsString::from)).is_err());
        assert!(Options::parse(["--interactive-sessions"].map(OsString::from)).is_err());
    }
}
