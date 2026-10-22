fn main() {
    println!("cargo:rerun-if-changed=backend-version.txt");
    let version = std::fs::read_to_string("backend-version.txt")
        .expect("Run npm run desktop:prepare before compiling the desktop host");
    println!(
        "cargo:rustc-env=WORK_HUB_BACKEND_VERSION={}",
        version.trim()
    );
    tauri_build::build()
}
