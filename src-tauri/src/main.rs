#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{Options, Service};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::NewWindowResponse,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

struct Host {
    options: Options,
    binary: PathBuf,
    agent: Option<PathBuf>,
    service: Mutex<Option<Service>>,
    origin: Mutex<Option<String>>,
    working: AtomicBool,
}

fn status_url(_app: &tauri::AppHandle, message: &str) -> tauri::Url {
    // Use the same bundled origin on Windows/Linux and macOS. There is no
    // invoke handler or remote capability on either the startup or business page.
    let mut url = tauri::Url::parse(if cfg!(windows) || cfg!(target_os = "linux") {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    })
    .unwrap();
    url.query_pairs_mut().append_pair("error", message);
    url
}

fn show_notice(app: &tauri::AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("notice") {
        let _ = window.close();
    }
    let _ = WebviewWindowBuilder::new(
        app,
        "notice",
        WebviewUrl::External(status_url(app, message)),
    )
    .title("Work Hub · 提示")
    .inner_size(720.0, 420.0)
    .build();
}

fn show_error(app: &tauri::AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(status_url(app, message));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn connect(app: tauri::AppHandle, stop: bool) {
    let host = app.state::<Host>();
    if host.working.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let host = app.state::<Host>();
        if stop {
            let mut options = host.options.clone();
            if let Some(service) = host.service.lock().unwrap().as_ref() {
                options.data = Some(service.data_dir.clone());
            }
            match backend::stop(&host.binary, &options) {
                Ok(()) => app.exit(0),
                Err(message) => show_notice(&app, &message),
            }
        } else {
            match backend::start(&host.binary, &host.options, host.agent.as_ref()) {
                Ok(service) => {
                    let mut url = tauri::Url::parse(&service.url).unwrap();
                    *host.origin.lock().unwrap() = Some(url.origin().ascii_serialization());
                    if let Some(window) = app.get_webview_window("main") {
                        // Keep the selected task/environment when reconnecting to a new port.
                        if let Ok(old) = window.url() {
                            if old.host_str() == Some("127.0.0.1") {
                                url.set_query(old.query());
                                url.set_fragment(old.fragment());
                            }
                        }
                        *host.service.lock().unwrap() = Some(service);
                        if let Err(error) = window.navigate(url) {
                            show_error(&app, &error.to_string());
                        }
                    }
                }
                Err(message) => show_error(&app, &message),
            }
        }
        host.working.store(false, Ordering::SeqCst);
    });
}

fn menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let reconnect = MenuItem::with_id(app, "reconnect", "重新连接后台", true, None::<&str>)?;
    let close = MenuItem::with_id(
        app,
        "close",
        "关闭窗口（保留后台）",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let stop = MenuItem::with_id(
        app,
        "stop",
        "退出并停止后台",
        true,
        Some("CmdOrCtrl+Shift+Q"),
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        "退出桌面端（保留后台）",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let work = Submenu::with_items(
        app,
        "Work Hub",
        true,
        &[
            &reconnect,
            &PredefinedMenuItem::separator(app)?,
            &close,
            &quit,
            &stop,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&work, &edit])
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::parse(std::env::args_os().skip(1))?;
    let binary = backend::binary_path()?;
    if options.stop {
        backend::stop(&binary, &options)?;
        return Ok(());
    }
    if options.backend_info {
        let service = backend::start(&binary, &options, None)?;
        println!("{}", serde_json::to_string(&service)?);
        return Ok(());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Refuse to silently switch an existing window to another profile.
            let host = app.state::<Host>();
            let incoming = Options::parse_at(args.into_iter().skip(1).map(Into::into), cwd.into());
            if let Err(message) = &incoming { show_notice(app, message); return; }
            if let Ok(incoming) = incoming {
                let service = host.service.lock().unwrap();
                if let Some(service) = service.as_ref() {
                    let same = |requested: &Option<PathBuf>, active: &PathBuf| requested.as_ref()
                        .is_none_or(|p| p.canonicalize().unwrap_or_else(|_| p.clone()) == *active);
                    if !same(&incoming.data, &service.data_dir) || !same(&incoming.root, &service.root) {
                        // Keep the current task intact; report the conflict in a separate window.
                        show_notice(app, "另一个数据目录或工作区的桌面窗口已经打开。请先关闭该窗口，再使用新的启动参数。");
                        return;
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let agent = app.path().resource_dir()?.join("agents").join(format!("worktree-hub-linux-{}", if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" }));
            app.manage(Host { options, binary, agent: agent.is_file().then_some(agent),
                service: Mutex::new(None), origin: Mutex::new(None), working: AtomicBool::new(false) });
            app.set_menu(menu(app)?)?;
            let handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Work Hub").inner_size(1380.0, 900.0).min_inner_size(900.0, 600.0).center()
                .on_navigation(move |url| {
                    let bundled = url.scheme() == "tauri" && url.host_str() == Some("localhost")
                        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost");
                    bundled || handle.state::<Host>().origin.lock().unwrap().as_ref()
                        .is_some_and(|origin| *origin == url.origin().ascii_serialization())
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    // Tauri exits; the detached Go backend intentionally outlives it.
                    handle.exit(0);
                }
            });
            connect(app.handle().clone(), false);
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "reconnect" => connect(app.clone(), false),
            "stop" => connect(app.clone(), true),
            "quit" => app.exit(0),
            "close" => { if let Some(window) = app.get_webview_window("main") { let _ = window.close(); } }
            _ => (),
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Work Hub: {error}");
        std::process::exit(1);
    }
}
