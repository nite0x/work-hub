# Work Hub

任务、项目和会话按目录范围解耦：任务默认展示明确关联的对话，目录聚合用于查找关联候选；项目聚合其所有 worktree 中的对话。会话索引和运行状态独立于任务，完整消息仍由当前运行环境的 Codex 保存。数据模型、通用接口、旧数据迁移与共享界面见 [会话架构说明](docs/session-architecture.md)。任务和项目各保留一个对话入口，会话独立页与居中浮层复用同一套列表、目录筛选和详情。

以任务组织跨项目开发的个人开发工作台。Tauri 桌面端通过独立 Go 后台管理本机仓库；Windows 还可接入 WSL 执行环境。Go 后端通过 `go:embed` 复用 HTML / CSS / JavaScript 页面，SQLite 保存项目和任务关系，运行时不需要 Node 或前端构建工具。

任务内对话使用 assistant-ui，复用现有 Go API 和当前执行环境的 Codex。Windows 本机和 WSL 均可直接新建、继续对话，查看实时回复、停止当前轮次和处理审批，无需打开终端窗口。各环境仍需安装并登录 Codex CLI；Assistant Cloud 不参与数据存储或模型调用。

对话输入框支持粘贴截图、拖入图片或通过附件按钮选择图片，发送前可预览和移除，也可只发送图片。支持 PNG、JPEG、GIF 和 WebP；每条消息最多 4 张，每张不超过 4 MiB，总计不超过 8 MiB。图片直接随消息传给当前执行环境的 Codex，历史消息仍以「图片附件」标记展示。

任务页以目标和项目工作现场为主体，支持编辑说明、更换目录和解除项目关联；页头「相关会话」打开明确引用的会话，并可新建、关联或取消关联；项目页的「项目对话」打开项目全部 worktree 的会话，目录行不再重复放置入口。浮层内可按目录筛选；选择单个目录后，新建会话固定使用该目录，聚合范围新建则必须先选择具体目录。左侧「会话」进入独立页，可搜索范围和对话，并切换执行环境。浮层「转到会话页」携带当前范围、目录、选中会话和阅读位置，复用同一个挂载实例；各会话共享草稿、图片附件和控制器。关闭浮层或离开会话页只断开界面订阅，不停止后台运行，执行、待确认和未读状态显示在会话列表和导航中。

## Tauri 桌面端

Tauri 2 桌面宿主复用现有 Go 页面、HTTP API、SQLite 和实时事件流，业务页面不获得 Tauri shell 或文件系统权限。支持独立后台、macOS 系统 Terminal，以及各平台原生安装包；关闭窗口后后台继续运行。

开发需要 Go、Rust 和 Node.js，以及 Tauri 对应平台的系统构建依赖：

```bash
npm ci
npm run desktop:dev
# 显式指定数据目录和工作区；相对路径按启动时的目录解释
npm run desktop:dev -- --data /path/to/data --root /path/to/workspaces
```

开发命令不启动额外的前端服务器；窗口加载 Go 提供的页面。修改 Go 或 web 源码后，退出并停止后台，再重新运行开发命令。构建脚本用源码摘要标识后台版本，版本不一致时拒绝静默复用旧后台。

```bash
# 只准备当前目标平台的 Go sidecar；直接 cargo build/test 前也需要执行
npm run desktop:prepare
# 直接调用 Tauri 构建；默认使用当前平台安装包配置
npm run desktop:build
# macOS 本地调试应用包
npm run desktop:build -- --debug --bundles app
```

- 关闭主窗口（包括 ⌘W / Ctrl+W）只退出 Tauri，独立 Go 后台和定时任务继续运行；再次打开复用同一后台。
- ⌘Q / Ctrl+Q 或应用菜单的“退出并停止后台”会先安全停止后台，成功后退出桌面端。停止前由 Go 校验本机及已连接 WSL 环境的写锁；正在操作时提示原因并保留应用，不强杀 Git 或用户终端。应用菜单也提供“重新连接后台”。
- 桌面宿主也支持 `--data`、`--root` 和 `--stop`。`--backend-info` 可在不打开窗口时启动/复用后台并输出不含令牌的诊断信息。
- 后台仅监听 `127.0.0.1` 的随机端口。日志保存在业务数据目录的 `desktop.log`；`service.json` 用于实例发现和认证，不应分享其内容。
- 数据目录沿用旧版：Windows 为 `%LOCALAPPDATA%\WorktreeHub`，macOS/Linux 为 `~/.local/share/worktree-hub`。默认工作区仍为 `~/workspaces`。已有任务和 worktree 不搬迁。
- 已有后台的工作区与显式 `--root` 不一致时会报错；未指定 `--root` 时复用后台实际工作区。旧版本或交互模式后台需先通过原程序的 `--stop --data ...` 安全停止。
- Windows 构建额外携带对应架构的 WSL Linux 辅助程序；Tauri 显式传递资源路径，保留原有 WSL 通信和部署协议。

生命周期验收（使用临时数据目录，不操作已有项目）：

```bash
npm run desktop:test
# 将目标后缀换成当前 Rust target triple；也可追加桌面宿主路径，验证完整启动链
node scripts/desktop-smoke.mjs src-tauri/binaries/work-hub-backend-aarch64-apple-darwin \
  src-tauri/target/debug/work-hub
# 双项目任务、真实本地 Git 远端、分支保护、会话历史及归档恢复
node scripts/desktop-workflow-smoke.mjs src-tauri/binaries/work-hub-backend-aarch64-apple-darwin
# 对本机安装的 Codex CLI 做只读协议兼容检查
WORKTREE_HUB_TEST_INSTALLED_CODEX=1 go test ./internal/session -run '^TestInstalledCodexSessionProtocol$' -v
```

流程脚本使用临时仓库和独立数据目录，Codex 使用确定性测试进程，不发送模型请求。追加 `--keep` 可保留隔离后台和样例任务供原生窗口检查。真实 Codex 检查只读取本机会话列表、元数据和历史，不创建会话。

### macOS 终端

- 默认使用系统 Terminal，旧设置中的“系统终端”也会解析为 Terminal。任务启动、项目终端、Git 终端及继续会话共用此设置；设置页按执行平台显示可选工具，macOS 隐藏 WSL 连接入口。
- 使用 LaunchServices 打开权限为 `0700` 的 `.command` 文件，无需 AppleScript 自动化授权。脚本进入对应 worktree，Codex 结束后保留交互终端；支持路径中的中文、空格、引号和 shell 特殊字符。
- Finder 启动时，后台从用户登录 shell 读取 PATH（最多等待 3 秒），保留显式继承的路径优先级，并补充 Homebrew 和常用系统目录。终端脚本沿用后台解析的 PATH 和显式 `CODEX_HOME`，使会话查看与终端使用同一 CLI 配置。安装或切换 CLI 后，安全停止后台再打开应用以重新发现环境。
- Git 网络操作沿用用户现有 Git 凭证助手；如需认证，在项目终端完成登录。

原 Go 浏览器/headless 入口继续可用。下面的旧版 Windows WebView2 构建和安装脚本仅保留为兼容入口，新桌面版本统一使用 Tauri 安装包。

### 构建安装包

在对应操作系统上构建，不用 macOS 交叉生成 Windows/Linux 安装器。当前提供以下四个目标；不生成 Universal、Windows ARM64、Linux ARM64 或 RPM 包。

| 平台 | Rust target | 安装格式 | 运行基线 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `aarch64-apple-darwin` | DMG | macOS 12+ |
| macOS Intel | `x86_64-apple-darwin` | DMG | macOS 12+ |
| Windows x64 | `x86_64-pc-windows-msvc` | NSIS `-setup.exe` | Windows 10/11、WebView2 |
| Linux x64 | `x86_64-unknown-linux-gnu` | DEB、AppImage | 以 Ubuntu 22.04 构建；需要 WebKitGTK 4.1 |

构建机需安装 [Tauri 官方系统依赖](https://v2.tauri.app/start/prerequisites/)、Git、Node.js 22+、Go 和 Rust。CI 固定 Go 1.26.2、Rust 1.95.0；本地建议使用相同版本。Go 模块和 Cargo 依赖首次构建需要下载。Windows 安装器缺少 WebView2 时从微软下载安装，因而首次安装可能需要联网；Git 和 Codex CLI 由用户自行安装。发布包运行时不依赖 Go、Rust 或 Node.js（Codex 自己的安装要求除外）。

```bash
npm ci
npm run desktop:check
# 当前平台的正式优化构建，并收集安装包和校验信息
npm run desktop:package
# 构建指定架构；先用 rustup target add 安装对应 target
npm run desktop:package -- --target x86_64-apple-darwin
# 仅检查版本、目标、签名配置，不执行编译
npm run desktop:package -- --dry-run
# 需要更快的本地安装流程验证时，单独生成 debug 包
npm run desktop:package -- --debug
```

产物集中在 `dist/desktop/<版本>/<target>/release/`，debug 包单独放在 `debug/`。包括安装器、`README.md`、Go/Rust 完整依赖许可 `THIRD-PARTY-NOTICES.txt`、记录源码提交及未提交状态的 `release.json`，以及覆盖这些文件的 `SHA256SUMS`。包内也携带许可文本。校验和用于核对文件完整性，不等同发布者签名；Linux 可运行 `sha256sum -c SHA256SUMS`，macOS 可运行 `shasum -a 256 -c SHA256SUMS`，Windows 可用 `Get-FileHash -Algorithm SHA256` 对照。

Windows 发布目录另含 `Upgrade.cmd`、`Upgrade-WorkHub.ps1` 和安全停止后台的 helper。完整解压后双击 `Upgrade.cmd`，脚本校验包内文件，关闭当前安装目录的桌面窗口，安全停止默认后台，将完整业务数据和旧版程序备份到 `%LOCALAPPDATA%\WorktreeHubBackups\<时间戳>`，核对数据库备份后覆盖安装并重新打开应用。已有安装位置从当前用户卸载注册表读取；新装默认 `%LOCALAPPDATA%\Work Hub`。有 Git 写操作时停止并提示重试；自定义 `--data` 的后台需先手动安全停止。脚本不搬迁仓库、worktree 或 Codex 历史。

应用版本以 `package.json` 为准，Tauri 直接读取它；`src-tauri/Cargo.toml` 的版本必须相同，更新版本时也需更新并提交 `Cargo.lock`。后台身份为应用版本加业务源码摘要。打包命令在编译前拒绝版本不一致、错误系统的目标以及不完整的签名配置，清理本次目标的旧安装包，避免误发上一次产物。Go、Tauri、WSL helper 随同一次构建交付。

`.github/workflows/desktop.yml` 在手动运行或推送 `desktop-v<版本>` 标签时构建四个目标，上传 Actions artifacts；不自动创建或公开 GitHub Release。标签必须与应用版本一致。标签构建要求 macOS/Windows 发布签名；手动运行默认允许未签名测试包。Windows/Linux 作业包含实际安装、后台运行时升级保护、设置保留和卸载保留数据的验收脚本；macOS 作业从 DMG 复制应用到临时安装目录，检查宿主与 sidecar 的完整生命周期。这些作业需要在远端实际运行后，才能作为对应平台的验收结论。

### 安装、升级和卸载

- **macOS**：打开对应 CPU 的 DMG，把 `Work Hub.app` 拖到 `/Applications`（或用户自己的 `~/Applications`）后再运行。升级前在应用菜单选择“退出并停止后台”，再替换 `.app`；仅关闭窗口会保留后台，不能作为升级前的停止操作。卸载前同样安全停止，再把应用移入废纸篓。
- **Windows**：运行 `-setup.exe`，按当前用户安装并创建开始菜单和卸载入口，无需管理员权限。默认应用目录为 `%LOCALAPPDATA%\Work Hub`；旧版脚本安装目录为 `%LOCALAPPDATA%\Programs\WorktreeHub`，二者共用既有 `%LOCALAPPDATA%\WorktreeHub` 业务数据。首次迁移后从新开始菜单入口启动，确认记录正常再清理旧版程序文件。后续运行新安装器会沿用 Tauri 保存的安装位置。覆盖安装和卸载前，安装器从临时目录运行新 helper，认证并安全停止默认后台；正在 Git 写操作、后台启动中或认证失败时中止，不强杀进程。使用过自定义 `--data` 时，必须先逐个安全停止这些后台并关闭窗口，再安装/卸载。
- **Linux DEB**：`sudo apt install ./work-hub_<版本>_x86_64-unknown-linux-gnu.deb`；包管理器安装 WebKitGTK、GTK 和 Git 依赖，提供应用菜单入口及 `/usr/bin/work-hub`。升级和卸载前选择“退出并停止后台”。维护脚本检测到 `/usr/bin` 中的宿主/后台仍运行会拒绝替换；不会以 root 打开用户数据库或跨用户停止进程。卸载使用 `sudo apt remove work-hub`（以 `dpkg-deb -f <文件.deb> Package` 显示的包名为准）。
- **Linux AppImage**：放到固定的用户应用目录，例如 `~/Applications`，`chmod +x <文件.AppImage>` 后运行；部分发行版需要 FUSE 2，系统仍需 Git 和可用终端。升级前安全停止后台，再替换同一位置的文件。卸载前安全停止，再删除 AppImage。AppImage 不自动注册系统菜单，也不使用 systemd。

上述安装、升级和卸载不会移动或删除 `~/workspaces`、项目仓库、任务 worktree 或业务数据库；WSL 内的项目目录也保持原状。业务数据默认目录仍是 Windows `%LOCALAPPDATA%\WorktreeHub`、macOS/Linux `~/.local/share/worktree-hub`。手动删除这些数据不属于卸载步骤。新版本遇到正在运行的旧后台会明确拒绝复用，可通过原应用菜单安全停止再重新打开；不要删除 `service.json` 或结束 Git 进程来绕过保护。

如窗口已关闭，可通过已安装的宿主停止指定后台，例如 macOS：

```bash
"/Applications/Work Hub.app/Contents/MacOS/work-hub" --stop
"/Applications/Work Hub.app/Contents/MacOS/work-hub" --stop --data /自定义数据目录
```

Windows 使用安装目录中的 `work-hub.exe --stop`，Linux DEB 使用 `work-hub --stop`。安装 helper 的 `work-hub-backend --prepare-upgrade [--data ...]` 是幂等入口：未启动时成功返回，已启动时只能通过认证和写锁检查后安全退出，不会创建一个新后台。

### 发布签名

本地 `desktop:package` 默认允许测试包。正式交付 macOS/Windows 时使用 `npm run desktop:package -- --require-signing`，缺少凭证会在编译前报错。

- **macOS**：本地钥匙串准备 Developer ID Application 证书，设置 `APPLE_SIGNING_IDENTITY`。公证使用 `APPLE_ID`、应用专用的 `APPLE_PASSWORD`、`APPLE_TEAM_ID`，或使用 `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`。Tauri 负责签名、公证和 stapling。CI 另需 `APPLE_CERTIFICATE`（P12 的 base64）及 `APPLE_CERTIFICATE_PASSWORD`，上述身份和 Apple ID 公证参数使用同名 repository secrets。没有证书的本地包不具备 Developer ID 公证资格，不能据此宣称通过 Gatekeeper 验收。[Tauri macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/)
- **Windows**：本地用户证书库准备代码签名证书，设置 `WORK_HUB_WINDOWS_CERTIFICATE_THUMBPRINT`；打包使用 SHA-256 和时间戳。CI 可配置 `WINDOWS_CERTIFICATE`（PFX 的 base64）及 `WINDOWS_CERTIFICATE_PASSWORD`，作业导入后自动传递指纹。硬件令牌或外部签名服务需按发布环境另外配置 Tauri `signCommand`，当前工作流不假设存在这些服务。[Tauri Windows 签名说明](https://v2.tauri.app/distribute/sign/windows/)

代码库不保存证书、私钥或公证密码；CI 当前只上传构建产物。应用内自动更新、更新服务器和启动时自动替换后台不在本阶段实现，升级继续使用安装器或手动替换应用。

## 旧版 Windows 桌面端

在 Linux/WSL 中生成 Windows x64 发布目录（无需交叉 C 编译器）：

```bash
bash scripts/build-desktop.sh
```

构建脚本使用固定版本的 go-winres 嵌入多尺寸应用图标，首次构建需下载该 Go 工具。图标源文件为 `web/work-hub.svg`，Windows 使用 `web/work-hub.ico`（16–256 像素），桌面窗口、程序文件和开始菜单共用该图标。

生成 `bin/windows-amd64/WorkHub.exe`、`agents/worktree-hub-linux-amd64` 以及安装脚本。Windows 上可直接运行 exe，或双击同目录 `Install.cmd` 安装到当前用户目录并创建开始菜单入口。需要 WebView2 Runtime、本机 Git；查看和继续会话另需本机 Codex CLI。**Windows 本机项目不需要安装 WSL、Go、Node 或 GCC**；Codex 自己的安装方式如依赖 Node，仍遵循其要求。

- 本机工作区默认 `%USERPROFILE%\workspaces`，可通过 `--root` 指定；原有任务始终使用保存的路径。
- 应用现名为 Work Hub。为兼容已有安装，安装目录继续使用 `%LOCALAPPDATA%\Programs\WorktreeHub`，数据目录、数据库文件名及 WSL 辅助程序路径沿用原名；升级会替换开始菜单入口，已有项目和任务无需迁移。
- 本机数据库与设置默认位于 `%LOCALAPPDATA%\WorktreeHub`。WSL 环境的任务元数据也保存在该 Windows 目录下，各环境独立存放在 `environments/<环境标识>/`，不会在辅助程序中维护第二份任务列表。
- 关闭桌面窗口保留本机后台，重新打开会复用已有服务。运行 `WorkHub.exe --stop` 可在无项目写操作时退出后台；自定义 `--data` 时退出命令也需传同一目录。
- `WorkHub.exe --headless --listen 127.0.0.1:4317` 可使用浏览器访问；后台日志在数据目录 `desktop.log`。
- Windows 终端使用 PowerShell 脚本，支持 Windows Terminal、独立 PowerShell、Otty 及兼容终端。脚本以参数引用传递路径和提示词，不依赖 Bash。

### 接入 WSL

在左侧进入“设置”，点击“连接 WSL”，选择已安装的发行版，可指定 Linux 用户和工作区根目录。应用通过 `wsl.exe` 自动部署随发布包提供的 Linux 辅助程序，然后复用一条私有 stdin/stdout JSONL 连接；无需 SSH 服务和监听端口。辅助程序按内容摘要存放在该用户 `~/.local/share/worktree-hub/agents/` 下，文件操作和 Git 命令在 WSL 内执行。

登记项目时选择执行环境，再填写该环境的目录路径。Windows 本机使用 `D:\projects\app`；WSL 使用 `/home/user/projects/app`。本机入口会拒绝通过 `\\wsl.localhost\...` 直接管理 WSL 仓库。创建任务时先选择执行环境，只能选择该环境中的项目，创建后环境固定。任务列表汇总所有环境，点击任务自动进入其所属环境；项目视图和设置页可分别选择要管理的环境。已有任务按原数据库所属环境归属，记录及目录保持不变。一个任务的 worktree 仍集中在 `<工作区根目录>/<任务标识>/<项目名>`。

连接时可选择导入该 WSL 用户原有的 Work Hub 记录。导入只读取原 `~/.local/share/worktree-hub/worktree-hub.db` 的一致性快照，事务性复制记录到空的 Windows 环境数据库；仓库、worktree 和任务保存路径均不搬迁。导入后应通过桌面端维护该份记录，原服务数据库不会继续同步。导入失败不保留半份记录，也不覆盖已有环境。

WSL 停止或连接中断后，任务列表仍显示本机保存的任务及其环境；列表汇总不会启动未连接的 WSL。打开该环境的任务时自动连接，连接中断可在“设置”中选择环境并点击“重新连接”。写操作不会自动重发；先刷新检查实际结果，任务部分创建可使用原有“重试失败项”恢复。WSL 定时更新在该环境连接后随桌面后台运行，未连接的发行版不会为定时更新而自动启动。

应用有两个核心概念：

- **项目**：长期维护的代码项目，登记其 Git 仓库后，可供多个任务复用。
- **任务**：一次有明确完成目标的开发工作，集中组织参与项目的工作目录、分支和会话，可用于功能开发、问题修复、重构或技术试验。

一个任务可以关联多个项目，一个项目也可以参与多个任务。“任务”描述需要完成的开发工作；任务的工作区总目录用于集中存放各项目独立的工作目录（Git worktree）。工作区根目录默认是 `~/workspaces`，各任务的工作区总目录位于其下。

## 功能

- 项目视图：登记 Git 仓库主目录，自动发现全部 worktree、实际分支、修改数量、相对默认分支（master 或 main）的提交差异和关联任务。每 10 秒刷新，也可手动刷新。
- 状态读取直接返回缓存；过期状态由后台最多 4 个并发检查更新，各 worktree 完成后独立发布，慢目录不会阻塞页面或其他目录的结果。首次检查显示“正在检查”，后续更新保留上次结果和检查时间；后台更新时页面每秒读取进度，空闲时每 10 秒检查，手动刷新可立即触发重新检查。Git 操作和创建 worktree 后缓存自动失效；启动终端及 Git 写操作仍实时校验目录和分支。
- 手动创建 Worktree：在项目详情点击“创建 Worktree”，选择新建分支的来源，或使用未被占用的已有本地分支；按“根目录/工作标识/项目名”集中创建，创建后自动发现并显示“未关联任务”。不要求本地 master，来源默认优先 master 或 main，支持自行选择。
- Git 操作面板：查看本地/远端分支及 worktree 占用；获取远端全部分支；创建分支和跟踪关系；切换本地分支或从远端分支创建并切换；快进拉取；推送指定分支（首次可设置上游）；预览并合并来源分支；快进更新未检出的本地分支；打开指定 worktree 的 Git 终端。
- 任务内直接拉取、推送和切换分支，面板固定使用该任务项目的目录。切换时更新当前任务的关联分支，保留创建基线；共享目录切换前提示其他关联任务。外部切换后显示变化提示，可采用当前分支。同步状态单独展示上游、待推送和待拉取数量，基于最近获取的远端记录，与相对默认基线的差异分别显示。
- 合并出现冲突时提示冲突文件，并自动打开对应项目的 AI：桌面只读模式打开带合并上下文的 Codex 终端，Linux 交互模式创建任务关联侧栏会话。AI 接收当前目录、目标分支、HEAD、MERGE_HEAD 和冲突清单，负责解决冲突、必要验证及完成合并提交，不自动推送。启动失败保留合并状态，支持重新打开 AI、手动处理或中止合并；重试同一次启动请求不会重复创建。
- 项目卡片、项目工作目录和任务关联项目提供“远端仓库”“VS Code”“IDEA”入口。远端仓库优先当前分支的远端，其次 origin 或唯一远端；支持 HTTPS 和常见 SSH 地址，打开前去除内嵌凭证。编辑器在项目页打开选中目录，在任务页打开任务对应目录；Windows 连接 WSL 时，VS Code 使用 WSL 远程目录，IDEA 使用 WSL UNC 路径。编辑器需已安装；Windows 自动查找标准安装目录和常见 Toolbox 目录，Linux 需将 code 或 idea/idea.sh 加入 PATH。
- 任务视图：填写目标并选择参与项目，各项目默认新建分支和 worktree，也可使用原目录或已有 worktree。无需指定主项目或目录标识；全部复用时不创建任务文件夹。可编辑目标、单独重试失败项目、更换工作目录和移除项目关联；旧目录、分支和会话保留。
- 独立任务页面：点击任务进入专属页面，支持复制页面地址、刷新和浏览器前进/后退；集中查看关联项目的实际分支、修改状态和相对默认分支（master 或 main）的提交差异。
- 任务中随时添加项目：在“关联项目”点击“添加项目”，多选尚未关联的仓库，也可直接登记新仓库后返回选择。每个项目可选择原目录、已有 worktree 或新建工作目录；新建时可修改分支名称与来源，目录集中到任务原有总目录；保留已有项目及说明笔记，新增项目追加到 `BRIEF.md`，失败项可重试。归档任务需先取消归档。
- 在任务页面直接打开各项目的终端或 Git 操作，默认使用该任务中对应项目的工作目录；目录不可用时提示并停用入口，不会回退到仓库主目录。
- 批量创建前检查所选来源分支、工作目录及冲突；中途失败保留成功项，支持重试失败项，不覆盖现有文件。
- 设置页面：集中管理执行环境连接、终端工具和每日 master 更新；侧栏可随时切换执行环境。配置表单的未保存输入会在后台状态刷新和页面切换时保留。
- 统一终端设置：支持 macOS Terminal、Windows Terminal、Otty 和自定义命令行程序路径，所有 Codex / Git / 终端获取入口共用配置，刷新页面和重启服务后保留。
- 从任务启动对应执行环境的 Codex 终端：主项目 worktree 作为 `--cd`，打开后等待用户输入，不自动发送任务说明或开始对话。任务说明保存在工作区目录的 `BRIEF.md`。交互兼容模式的可交接终端通过控制连接为 workspace-write 策略追加其他项目目录，避免远程连接与 `--add-dir` 冲突；保留原有沙箱模式和审批策略。独立启动及复制的命令仍使用 `--add-dir`。
- 任务关联会话：自动发现工作区总目录及各项目 worktree 根目录中的 Codex 会话；支持搜索、选择或粘贴会话 ID 手动关联其他目录中的会话，并在所选终端中一键继续。
- 会话详情侧栏：在任务页查看历史消息、Codex 回复和命令执行记录；终端中的回复和命令输出通过实时推送边生成边显示，按需加载更早记录，查看退出码及耗时。
- assistant-ui 任务对话：直接新建或继续会话，通过 SSE 显示实时回复、命令输出和文件修改，支持停止、批准、拒绝和回答问题。关闭面板后后台继续工作，重新打开可恢复当前状态。
- 归档任务保留全部 worktree 和分支。第一版不提供物理删除 worktree，避免误清理其他工具创建的工作。

## 运行

从源码运行需要 Go 1.23.12+、Git 和 Node.js 22.12+；首次执行 `npm ci`。启动及桌面打包脚本自动构建前端。SQLite 使用纯 Go 驱动，不需要 GCC；生成的程序运行时不依赖 Node。各执行环境需安装 Codex CLI，并在首次使用前完成 `codex login`。

```bash
cd /home/nite/projects/worktree-hub
npm ci
bash scripts/run.sh
```

在 Windows 浏览器打开 http://localhost:4317 。

```bash
# 可调整端口、数据库存放位置和 worktree 根目录
bash scripts/run.sh --listen 127.0.0.1:4317 \
  --data "$HOME/.local/share/worktree-hub" \
  --root "$HOME/workspaces"
```

默认 worktree 根目录为运行环境的 `~/workspaces`（当前 WSL 用户为 `/home/nite/workspaces`），不自动选择 Windows 挂载盘；可通过 `--root` 明确指定其他位置。已有任务使用数据库中保存的原路径，不会自动迁移。

Linux 默认 SQLite 文件：`~/.local/share/worktree-hub/worktree-hub.db`，原有 SQLite 数据文件可直接继续使用。

## 使用

1. 进入“项目与 Worktree”，输入 `/home/...` 或 `D:\project\...` 路径登记仓库。
2. 创建任务，先选择执行环境，再输入名称、英文目录标识和说明，选择同一环境中的主项目及参与项目。
3. 各项目默认使用原目录，也可以选择已有 worktree，保留当前分支和未提交修改；同一工作目录可关联多个任务。不要求仓库具有 `master`。
4. 如需独立工作目录，选择“新建分支和 Worktree”。分支名默认 `codex/<目录标识>`；来源优先本地 `master`、`main`，其次 `origin/master`、`origin/main`，都没有时使用当前 HEAD。每个项目都可自行修改名称和来源（本地或已获取的远端分支），创建时记录所选提交，不自动拉取远端。
5. 点击任务进入独立页面，查看每个项目的 worktree、实际分支及修改状态。各行的“打开终端”和“Git 操作”直接使用该行的工作目录；可通过“返回任务列表”或浏览器后退切换任务。
6. 在任务页点击「对话」，或在所选项目点击「项目对话」打开会话浮层。任务目录和未关联任务的 worktree 都可作为创建目录；聚合范围先选具体目录，再发送第一条消息。
7. 在浮层左侧筛选目录、搜索标题，点击会话阅读或继续。详情顶部显示实际执行环境和 cwd，切换入口不会改变已有会话的工作目录。
8. 需要集中查看时进入左侧「会话」独立页，或点击浮层的「转到会话页」。关闭浮层继续管理任务，运行不会停止；停止当前轮次需明确点击对话中的停止按钮。终端入口仍可用于打开 Codex，首次使用可能需要登录或信任工作目录。

### 每日拉取所有项目的 master

默认启用，每天北京时间 **09:00（Asia/Shanghai）** 更新所有已登记项目的本地 `master`。在“设置”页的“每日拉取 master”区域，可修改每日时间、关闭自动更新，查看最近一次执行中各项目的结果与原因。设置和执行记录保存在 SQLite，服务重启后保留。

- 服务运行时每 30 秒检查一次，浏览器关闭后继续执行。电脑休眠或服务停止期间不会执行；当天错过时间后，启动或恢复运行时补跑当天一次，不补跑历史日期。当天已开始过的更新（含失败或中断）不会因重启或改时间重复执行；可在项目 Git 操作中手动处理和重试。
- 优先使用 master 配置的远端；未配置时选择 `origin`，没有 `origin` 时仅在远端唯一的情况下选择它。只获取该远端的 `master`，兼容单分支克隆；upstream 指向其他分支时跳过，不使用 `main` 替代。缺少本地 master 时跳过，不影响项目登记、任务创建或使用其他分支。
- master 未检出时只快进更新该分支引用；master 已在 worktree 中检出时，在对应干净目录中快进并更新文件。任务分支及其工作目录保留，已有任务记录的基线提交不会变化。新建工作目录选择 master 时使用更新后的提交。
- master 所在目录有未提交修改、被锁定、正在 rebase/merge、目录不可用，或 master 存在本地独有提交/分歧时跳过。网络、凭证或远端 master 缺失等错误按项目记录，继续处理其余项目；不强制覆盖、不自动 stash 或合并分歧。自动更新沿用现有凭证助手，首次认证可在 Git 终端中完成。
- 关闭自动更新不取消已经开始的一次执行。服务退出会取消后台 Git，最近结果中会标记中断；请检查未完成项目后通过 Git 操作处理。

### 查看与继续 Codex 会话

页面通过当前执行环境的 `codex app-server` 读取会话和历史，通过共享后台的 `thread/start` / `thread/resume` / `turn/start` 接口创建和继续任务对话。已使用 Codex CLI 0.163.0 验证；对应环境的 PATH 必须能找到 Codex CLI。使用与终端相同的用户和 `CODEX_HOME`；Windows 和各 WSL 用户的会话分别读取，不会混用登录或记录。

- 任务范围按任务自身目录和成员目录聚合；项目范围按全部 worktree 聚合。目录使用 cwd 精确匹配，不包含子目录。每 10 秒刷新，也可在会话列表点击「刷新」。
- 当前范围之外的会话可从会话独立页的「全部会话」查找，范围选择支持搜索任务、项目和目录。旧手动引用仍兼容读取，不再在任务工作区放置独立关联入口。
- 继续已有会话保留原 cwd 和既有附加目录，不按当前任务重新计算，也不额外发送提示词或自动开始新一轮工作。目录不可用时说明原因；任务新建及任务终端入口仍按任务准备状态校验，已有会话可从独立页继续。
- 「新建」和继续对话共用 assistant-ui 详情。聚合范围必须选择创建目录；目录筛选不会改变已打开会话的 cwd。任务范围的新建沿用任务的执行上下文，项目范围的新建只使用所选 worktree，不要求任务关联。
- Codex 接口暂不可用时，保留已存的关联信息并显示错误；无法确认可读取的会话会停用继续入口。最近活动时间不代表会话当前运行状态。
- 会话详情通过 `thread/items/list` 分页读取历史；旧版会话使用 `thread/turns/list`。记录按时间顺序展示，仅展示用户消息、Codex 回复和命令执行记录。命令输出可展开，并显示保存的状态、退出码、耗时及可用的时间；未保存的字段不会被推测补齐。图片和音频以附件文字显示。
- 详情使用当前执行环境的 Codex 共享后台订阅终端事件，通过 SSE 推送回复文字和命令输出增量，每 50 毫秒合并一次显示更新。Windows 本机通过 CLI 的原生代理连接控制套接字，WSL 通过已有辅助程序转发；不新开网络端口。打开时读取最近一轮快照，避免中途查看时遗漏已生成的内容。
- 只向已在共享后台加载的会话发送不带配置覆盖的 `thread/resume` 以附加事件订阅，不发起模型工作，不修改模型、目录、沙箱和审批策略，也不回答审批或中断终端；未加载的历史会话只读取记录，等待终端加载。需要支持共享后台、事件和 `initialTurnsPage` 的 Codex CLI；当前已使用 0.163.0 验证。
- 打开的会话详情顶部会提示终端的待确认事项：展示收到的审批原因、命令、问题和选项，并在终端处理后自动清除。中途打开时如只能读取到等待状态，会提示到原终端查看具体问题；断线时标明提示尚未核实。这里仅提醒和展示，回答和审批仍在原终端完成。
- 推送正常时不再每秒请求历史；每轮结束后补读完整保存记录。连接暂不可用时保留已显示内容，降级为每秒读取历史并自动重连。保留已加载的旧记录、命令详情和输出窗口；停在底部时跟随新内容，向上阅读时保持位置。页面隐藏时暂停订阅和轮询，返回后补读并重连；关闭浮层或离开会话页会取消前端订阅，后台轮次继续。实时预览每条最多 256 KiB，完整输出保留在历史中。

### 在任务内继续对话（macOS、Windows 本机与 WSL）

任务内对话默认启用，macOS 也支持在窗口内新建会话和继续发送消息；`--interactive-sessions` 保留为兼容参数。以 `--headless --read-only-sessions` 启动可仅查看历史，只读历史同样使用 assistant-ui 展示 Markdown、表格和工具输出。Windows 接入 WSL 时，辅助程序以独立 stdio 通道双向转发 Codex 协议，不新增监听端口；消息、停止和审批始终发送到同一发行版和用户。macOS 使用本机进程参数检查同一会话的终端占用，继续对话前需先退出该会话的 Codex 终端；自动交接终端仍仅在 Linux/WSL 中提供。

点击关联会话卡片，在底部输入文字后点击“发送”或按 Ctrl+Enter。Enter 换行。页面通过所选执行环境的 Codex 共享后台服务恢复同一会话，沿用其模型、登录和审批策略；仅在已使用 workspace-write 沙箱时加入任务中其余项目的目录。已使用 Codex CLI 0.163.0 验证，需支持 `app-server daemon start/version` 和共享 Unix WebSocket 套接字。

- 回复、命令输出和文件修改实时显示。触发审批时展示命令、文件差异或所请求的权限；选择“允许一次”或“拒绝”。临时权限只授予当前一轮。问题支持选项和文字回答。外部工具的登录或复杂表单交互暂需停止后在终端完成，页面提供拒绝入口；未支持的交互会请求停止，避免静默批准或无限等待。
- “停止”只中断页面发起的当前一轮。关闭侧栏、切换任务或刷新页面不会停止工作，重新打开能接回执行记录和待审批项；网络断开会自动重连，不自动重新发送消息。单轮最多运行 30 分钟，到时请求停止。本地服务正常退出时也会请求停止自己发起的工作。
- 同一工作目录允许创建和同时运行多个独立会话，包括侧栏和终端。每个会话同时只允许一个页面运行；重复发送使用请求标识去重。会话正在页面运行时，通过本工具打开该会话终端会被拒绝。
- 发送前检查终端控制连接、执行环境中的交互式 Codex 进程以及共享后台运行状态。Linux/WSL 使用 `/proc`，Windows 使用原生进程查询，并保留共享后台的活动轮次检查。Codex 执行工具所用的 `codex-linux-sandbox` 进程不视为终端占用。仅在终端占用同一会话时阻止侧栏发送；同目录的其他会话不会阻止创建、发送或交接。无法核实进程状态时保留现场并拒绝发送。
- 运行中每秒检查终端是否重新接入；发现占用后请求中断页面这一轮。此检测针对同一 WSL 环境中的本地进程，不提供跨主机或绕过共享后台的独立客户端的全局互斥。请在页面和终端中选择一处操作同一会话。

### 新建会话与终端交接（Linux 兼容模式）

- “新建会话”直接打开空白侧栏，可在顶部切换工作项目，底部发送第一条消息后创建并自动关联会话；只打开或关闭侧栏不创建空会话。未发送的文字和项目选择在本页保留，失败时可直接重试。其他项目作为附加可写目录。首条消息使用创建时的同一个后台连接发出，避免空会话尚未保存导致无法恢复。新会话使用 workspace-write 沙箱及 on-request 审批，沿用当前 Codex 登录和默认模型。创建请求标识保存到 SQLite；网络失败或重启后的相同请求不会重复创建，结果不明确时提示先检查列表。
- 在可控终端会话的详情底部点击“切换到侧栏（等本轮结束）”。先禁止终端发起新请求，保留当前轮的执行、输出以及已有审批回答；等待本轮自然结束，再核实共享后台空闲，撤销终端连接并退出经本机套接字核实的 Codex 进程。终端窗口保留在工作目录，恢复正常输入状态，然后侧栏可以继续发送。
- 交接不会调用 `turn/interrupt`。思考、流式输出和命令执行不会因切换被强行停止。等待期间审批仍在原终端完成，也可“取消交接”让终端继续保有控制权。等待最多 30 分钟，超时取消交接，不停止原终端工作；关闭侧栏不取消后台交接。
- 终端连接绑定一个会话；需要新建、切换或 fork 到其他会话时，通过任务页操作。交接失败、另有无法核实的终端、目录不匹配或共享后台状态不明确时拒绝接管。此前已启动的终端、复制命令后手动启动的终端不具有可核实控制连接，需要先自行退出 Codex；以后通过工作台重新打开即可使用交接。
- 互斥保证适用于工作台管理的终端连接和侧栏入口。独立 CLI、其他用户或其他主机绕过工作台直接访问 Codex，不具备可撤销的全局控制锁；本机重新出现此类终端时仍采用上述占用检测。不会根据工作目录猜测进程后强行终止手动会话。
- 终端启动请求尚未连接时，页面显示“终端正在启动”，此时不能交接。启动器报错、登录失败或 Codex 提前退出会释放启动占用；终端一直未连接时最多保留 30 秒，然后可重试打开终端或在侧栏继续。
- 实时预览中每条消息或输出最多显示 256 KiB，超出时明确提示；完整保存记录仍可通过历史查看。聊天的完成状态和审批快照暂存在服务内存中，长期记录由 Codex 保存。

### 选择终端工具

进入左侧“设置”页的“终端工具”区域，选择 Windows Terminal、Otty 或自定义路径，然后保存。设置保存在服务的 SQLite 数据库中，所有浏览器页面共用，刷新页面和重启服务后保留。

- Windows Terminal：通过 PATH 中的 `wt.exe` 打开新窗口。
- Otty：检测 PATH 和当前 Windows 用户的常见安装位置，优先使用安装目录下的 `bin/otty.exe` 控制 CLI，在新标签页打开 WSL。Otty 未运行时会先启动应用，并等待窗口初始化后创建标签页、执行原启动或恢复命令；冷启动期间短暂出现的 `unknown command: tab.new` 会继续重试，整个打开过程最多等待 20 秒。

  运行中的 Otty 需支持新建标签页并执行传入命令。若返回 `unknown command: tab.new`，先完全退出并重新打开 Otty，确保运行实例与 CLI 一致；仍失败时可更新 Otty 或选择 Windows Terminal。仅打开默认 PowerShell 窗口不视为成功进入 WSL。
- 自定义路径：填写完整程序路径（`C:\...\terminal.exe` 或 `/mnt/c/...`），并选择 Windows Terminal、Otty 或“其他终端（支持 -e 程序 参数）”启动方式。Otty GUI 的 `otty.exe` 同目录存在 `bin/otty.exe` 时会自动使用后者；其他参数协议的终端需提供兼容包装程序。

Codex 启动、打开 Git 终端、在终端获取分支及认证失败后的终端登录入口都使用此配置。Windows 终端通过 `wsl.exe` 进入服务所在发行版，并直接执行项目启动脚本；原有主项目、附加目录和凭证助手行为保持一致。程序暂不可用时仍保留选择并提示错误，可修改路径或安装后重试。

### 选择其他来源分支

项目登记和任务创建都不要求 `master`。新建工作目录时，可以从下拉列表选择任意已有本地分支、远端分支或当前 HEAD；直接使用原目录或已有 worktree 时无需选择来源。

若需要的远端分支尚未获取，在项目的“Git 操作 · 分支管理”中点击“获取远端全部分支”，完成后重新选择来源。原目录保持原分支和修改；创建本地分支时可选设置远端跟踪关系。

如提示身份验证失败，点击“在终端登录并获取分支”，在终端按 Git 提示完成认证后刷新列表。WSL 环境自动检测 Git for Windows 的 Git Credential Manager，复用已保存凭证；已有凭证助手保留，应用数据库和启动脚本不保存密码或令牌。

在单分支克隆中，若新跟踪的分支缺少 fetch 映射，应用会追加该分支的映射并保留已有映射，以便 Git 正确识别 upstream。

工作目录存在未提交修改时，切换与拉取会被拒绝。其他 worktree 已检出的分支不能重复切换；更新分支只允许快进，有分歧时保留现状并返回 Git 终端处理。

```text
/home/nite/workspaces/order-approval/
├─ BRIEF.md
├─ frontend/
└─ backend/
```

工作区总目录是普通目录；各子目录保留独立 Git 状态。不会改变原始仓库目录的当前分支。

添加项目时，可点击仓库目录旁的“选择文件夹…”打开本机系统窗口，选定后自动填入绝对路径，取消则保留原输入。macOS 和 Windows 使用系统选择窗口；Linux 需要图形桌面及 `zenity` 或 `kdialog`，不可用时可继续手动填写路径。WSL 项目请手动填写该环境中的 Linux 绝对路径。

## 代码结构

后端按任务、项目、会话、工作区划分业务包，应用入口负责组装，前端按业务功能组织目录：

```text
main.go                      # 程序入口，转交 app.Run；保留 go run . / go build .
internal/
├─ app/                      # 服务组装、总路由、环境分发、启动和退出
│  ├─ app.go / routes.go / middleware.go
│  └─ run.go / desktop_service.go / environments.go / agent.go
├─ task/                     # 任务创建、重试、归档、关联项目及启动目录校验
│  ├─ service.go / routes.go
│  └─ requirements.go / requirement_projects.go / launch.go
├─ project/                  # 仓库登记、Git 操作、Worktree、状态缓存和 master 更新
│  ├─ service.go / routes.go / projects.go
│  └─ git*.go / worktrees.go / state_cache.go / master_sync.go / credentials.go
├─ session/                  # 会话关联、历史、实时对话、终端占用和交接
│  ├─ service.go / routes.go / sessions.go / launch.go
│  └─ session*.go / terminal_bridge.go / bridge_peer_*.go
├─ workspace/                # 同一执行环境的根目录、存储、写锁及本机 / WSL 执行
│  ├─ service.go / routes.go / client.go / stream.go / agent.go / wsl.go
│  └─ files.go / git.go / terminal*.go / sessions.go / credentials.go / names.go
├─ overview/                 # 页面状态汇总：组合项目、任务、终端和定时更新的只读数据
├─ model/                    # 项目、任务、Worktree、终端参数、更新结果等共享数据结构
├─ store/                    # SQLite 打开、迁移、恢复、查询和元数据导入导出
├─ codex/                    # Codex JSONL / WebSocket 客户端、事件分发与代理
├─ platform/                 # 跨平台路径、命令引用、进程隐藏、实例锁与桌面窗口
├─ httpx/                    # JSON 请求响应、本地访问、令牌和会话模式校验
└─ testutil/                 # 各模块测试共用的临时 Git 仓库和 HTTP 请求夹具
web/
├─ assets.go / handler.go    # 嵌入前端资源、注入页面令牌和会话模式
├─ index.html
├─ core/                     # 共享状态、API、导航与基础样式
└─ features/
   ├─ tasks/                 # 任务页面与关联项目
   ├─ projects/              # 项目、Worktree、Git 操作
   ├─ settings/              # 环境、终端与 master 更新设置
   └─ sessions/              # 会话、历史、实时显示和兼容模式对话
frontend/                    # React 组件入口、shadcn/ui 源码与 Tailwind 主题
scripts/                     # 启动、发布与前端测试脚本
winres/                      # Windows 程序图标资源配置
```

依赖方向为 `main → app → task / project / session / workspace / overview`。任务、项目和会话均通过具名的 `Workspace` 字段使用执行环境，不匿名嵌入工作区服务，避免将工作区的 HTTP 入口和生命周期方法提升为各业务模块的方法。会话只依赖自己声明的 `LaunchPlanner` 小接口，组装层注入任务服务；启动计划使用 `context.Context`，不将 HTTP 请求传入跨模块业务调用。任务、项目、会话之间没有具体包依赖；所有下层包均不依赖 `app`。

每个执行环境创建一个 `workspace.Service`，任务、项目和会话服务共享其中的存储、工作区根目录和写锁，保留创建 worktree、手动 Git 操作、定时更新之间的互斥。项目服务仅持有项目和 worktree 的私有状态缓存及更新调度状态，通过 `Snapshot`、`Close` 等操作供外部使用；终端可用性缓存由工作区持有，独立于 Git 扫描，每个环境同时只进行一次终端检查，设置变化时合并待检查项并丢弃旧结果。会话服务持有聊天、审批、终端占用和交接状态。

`overview` 通过项目状态接口汇总 `/api/state`，在响应中关联任务和 worktree；项目模块不再读取任务清单或组装整个工作台。工作区实时通道只传递 JSON，历史消息模型与格式转换由会话模块提供。各业务包通过 `RegisterRoutes` 注册自己的 HTTP 入口；任务写操作由组装层接入项目缓存失效回调。

终端启动失败通知作为单次启动参数传入，不在工作区上保存全局会话回调，构造另一个会话服务不会覆盖已有终端的失败处理。应用通过可重复调用的 `Close` 统一关闭会话、缓存、连接和数据库，环境重连和初始化失败复用同一个清理入口；调度器仍由启动它的组装层先停止。

`app` 只组装服务、分发执行环境和管理进程生命周期。业务流程及其事务放入对应业务包，基础查询与元数据迁移集中在 `store`，公共请求响应放入 `httpx`。新增功能应先明确所属业务模块，避免重新把业务状态放回 `App`。任务在代码和数据库中的既有 `Requirement` / `requirements` 名称继续沿用，API 和数据格式保持兼容。

前端使用 React 19、Tailwind CSS 4 和 shadcn/ui。组件源码在 `frontend/components/ui/`，`components.json` 管理组件生成路径，`@/` 指向 `frontend/`。任务、项目、Git、设置和会话界面统一使用同一套组件与主题，覆盖列表、表格、设置表单、环境连接、会话关联、历史卡片、命令输出和交互兼容模式的问答与审批控件。

`frontend/workspace/` 按任务、项目、Git、设置、会话和表单组织视图，`renderers.tsx` 通过 `renderToStaticMarkup` 生成原生 HTML，并以 `window.WorkHubUI` 提供给业务脚本。表单、设置页和共享会话浏览器结构在启动时渲染一次；动态列表、执行结果和历史记录只在原控制器要求刷新时生成。不创建 React root 或进行 hydration。原生事件委托、FormData、校验、轮询、API 和弹窗生命周期仍由原控制器维护；保留未保存设置、会话草稿、展开的命令、阅读位置和输出弹窗的实时更新。下拉框使用 shadcn Native Select，复选框使用原生 Input；保留 `<dialog>` 的焦点、Esc、忙碌保护与嵌套行为，避免改变现有操作流程。

`web/index.html` 先通过 `defer` 加载构建出的 `ui/ui.js`，同步生成组件标记，再依次加载 `core/core.js`、项目和任务页面、`core/app.js` 及各功能脚本。启动读取放在 `DOMContentLoaded` 中。Tailwind 不加载 Preflight，主题变量限定在 `.shadcn-scope`，避免覆盖已有页面样式；`hidden` 的优先级高于 display 工具类，保证旧控制器的显示状态继续生效。

```bash
npm run web:check           # 检查组件 TypeScript
npm run web:build           # 生成 web/ui/ui.js 和 ui.css，随后才能直接 go build/test
npm run web:test            # 类型检查、生产构建、前端交互回归测试
npm run web:watch           # 修改组件时持续构建；重新构建并重启 Go 后端后生效
npx shadcn@latest add label # 在仓库根目录添加更多组件
```

`web/ui/` 是忽略提交的构建产物，由 Go 嵌入并随程序分发，无 CDN 或运行时 Node 依赖。`scripts/run.sh`、Tauri sidecar 准备和旧 Windows 打包脚本均先构建前端，再构建 Go。新增脚本时同步维护首页加载顺序、嵌入范围和测试入口。`scripts/state-refresh.test.cjs` 使用真实组件渲染器检查轮询与两种会话模式下的业务脚本顺序；`scripts/workspace-ui.test.cjs` 在 DOM 中加载生产 bundle 与真实控制器，覆盖任务与 Git 流程、设置保存与草稿保留、WSL 连接、会话范围搜索、目录筛选、浮层与独立页复用、历史输出、审批和快捷键发送。会话专项测试同样使用真实组件渲染器检查流式更新、断线重连、旧请求隔离和草稿恢复。后端测试检查全部首页资源可从嵌入资源访问。

Go 测试与对应包放在一起：任务创建和项目添加测试在 `internal/task`，Git 和项目缓存测试在 `internal/project`，会话与终端交接测试在 `internal/session`，终端缓存和传输测试在 `internal/workspace`，应用组装、认证、环境分发和生命周期测试在 `internal/app`，独立通信协议测试在 `internal/codex`。测试通过各模块的正式路由注册入口组装最小服务，公共路由、状态汇总、安全校验、仓库和 HTTP 夹具由 `internal/testutil` 复用。在仓库根目录运行测试时使用 `./...`，以覆盖子包。

## 验证

```bash
export PATH="$HOME/.local/bin:$PATH"
npm ci
npm run web:check
npm run web:build
go test -race ./...
go vet ./...
go build -o bin/work-hub .
node --test scripts/*.test.cjs
```

集成测试使用临时真实 Git 仓库，覆盖 master/main 默认来源、自选来源、原目录与已有 worktree 复用、混合项目选择、旧数据库迁移、已有 worktree 发现、跨仓库预检查、分支/目录冲突、部分失败及重试、SQLite 重启、Codex 目录映射、分支漂移、命令参数引用和归档保留。

Git 操作测试另外使用本地裸仓库作为远端，覆盖单分支克隆获取 master、跟踪关系、保留未提交文件、分支占用、快进更新、分歧拒绝、终端目录范围与凭证脱敏。

会话测试覆盖跨任务隔离、自动发现与分页、手动关联和重启保留、元数据不可读取、恢复目录与附加目录、命令参数引用、协议通知及进程超时。历史测试覆盖新旧历史格式、消息顺序、命令输出与退出码、内部记录过滤、关联范围和失败处理。`node --test scripts/session-history.test.cjs` 额外验证分页、重试、文本安全显示、实时推送、中文分片解码、断线恢复和旧请求隔离（仅此开发测试需要 Node）。可选运行 `WORKTREE_HUB_TEST_INSTALLED_CODEX=1 go test ./... -run TestInstalledCodexSessionProtocol -v` 检查历史读取协议；运行 `WORKTREE_HUB_TEST_INSTALLED_CODEX=1 go test ./... -run 'TestInstalledCodex(Workspace)?HistoryPush' -v` 通过可丢弃的测试会话和简单输出命令验证本机及辅助程序的实时通道，不调用模型，不操作已有会话。

对话测试覆盖实时事件与 RPC 请求分发、重复发送、审批失效和拒绝、临时权限范围、问题回答、文件差异、停止、终端重新接入、任务隔离和 SSE 快照。前端测试运行 `node --test scripts/session-history.test.cjs scripts/session-chat.test.cjs`。`WORKTREE_HUB_TEST_INSTALLED_CODEX=1 go test ./... -run TestInstalledCodexLiveReadOnly -v` 检查共享后台连接；显式运行 `WORKTREE_HUB_TEST_CODEX_TURN=1 go test ./... -run TestInstalledCodexEphemeralTextTurn -v` 会在临时目录中的临时会话发起一次真实文字请求（可能使用账户额度），不调用工具。

新建与交接测试覆盖创建去重、未确认结果、项目范围、归档限制、交接等待、取消、终端请求门禁与审批回复保留、无法识别的终端拒绝接管。`WORKTREE_HUB_TEST_CODEX_TURN=1 go test ./... -run TestInstalledCodexNewSessionAndManagedTerminalHandoff -v` 在独立测试任务中创建真实会话，并用真实 TUI 流式输出验证等待结束后交接、完整回复保留；会使用账户额度，结束时仅清理测试创建的会话。

## 设计边界

- 页面仅监听本地回环地址，API 带页面级随机令牌并检查来源，防止其他网页静默调用本机 Git/终端能力。
- 添加项目只登记和扫描，不改仓库。发现的外部 worktree 显示为未关联，不会自动认领或移动。
- 任务可关联新建 worktree、项目原目录或用户明确选择的已有 worktree。同一目录可参与多个任务；Git 状态实时读取，选择方式和关联存入 SQLite。
- 同一仓库通过多个 worktree 路径重复登记会被拒绝；按 Git common directory 识别仓库。
- 创建是多个 Git 操作，不能跨仓库原子提交；发生失败时保留现场，不做破坏性回滚。
- 重试新建 worktree 时使用最初保存的来源提交，不悄悄改变基线。已成功的 worktree 不会重建。
- 启动前核验各工作目录所属仓库；新建 worktree 还会核验记录的分支和基线。复用的目录允许正常切换分支或使用 detached HEAD。
- 会话关联只保存 ID、简短标题、目录、时间及关联来源，不复制完整对话历史。模型调用由本地 Codex 执行，沿用其登录、模型与审批设置。
- 原生 CLI 的附加目录权限及各仓库指令文件，需要遵循其自身规则。

### 凭证复用

Git 操作面板显示凭证助手接入状态；“已接入”表示共用助手可用，不代表远端认证一定有效。后台只读取已有凭证，不弹出登录框；终端首次获取时由 Git 提示输入，认证成功后自动交给助手保存。

WSL 默认检测 `/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe`。命令级追加助手让终端与后台访问同一个 Windows 凭据管理器，服务重启后仍可使用。应用内置 `credential-helper get/store/erase` 桥接，只通过标准输入输出传递 Git 凭证协议，不将密码放进命令行。SSH 继续使用既有密钥与 agent。

对于项目原有的 HTTP 远端，仅当前助手调用允许对应 HTTP 凭证并使用 Basic/PAT；不会改远端地址、TLS 验证或全局设置。HTTPS 按助手自身规则处理。没有检测到 Windows 助手时保留现有 Git 凭证配置，并在页面说明。

验证包括真实 HTTP Basic 远端、终端首次认证后连续后台获取、后台快进拉取、服务重开后的凭证复用、失效凭证重登录、桥接环境和秘密不进入响应或启动脚本。测试凭证与助手均为隔离的临时模拟数据。

### 独立创建 Worktree

进入“项目与 Worktree”，选择项目，在详情点击“＋ 创建 Worktree”：

1. 填写工作标识，预览路径为 `<工作区根目录>/<工作标识>/<项目目录名>`，默认根目录为 `~/workspaces`。同一工作标识可为不同项目集中创建 worktree。
2. 选择“新建分支”，来源可选本地分支、已获取的远端分支或明确选择当前 HEAD。默认来源优先本地 master 或 main，其次 origin/master 或 origin/main，都没有时使用当前 HEAD；新分支默认 `codex/<工作标识>`，可自行改名。
3. 或选择“使用已有本地分支”；已被任一 worktree 占用的分支禁止重复检出。已有分支的 upstream 保留，新分支从选中提交创建，不自动建立远端跟踪。
4. 创建后项目表格自动刷新，显示路径、实际分支和修改状态，标记“未关联任务”。不会创建任务记录或修改原工作目录。

目录存在（包括空目录或符号链接）、分支冲突、分支被占用、来源消失、目录越界或工作目录属于已登记任务时均会拒绝。Git 钩子失败时保留现场，页面返回具体错误和目标目录，可刷新检查后在 Git 终端处理；不会自动删分支或文件。

聊天界面直接采用 assistant-ui 官方 registry 的 `Thread`、Composer、Markdown、工具调用和历史分页组件，保留现有 Codex external-store runtime。来源及少量适配记录在 `frontend/components/assistant-ui/README.md`；任务信息和应用审批复用现有 shadcn 组件。`chat:build` 会独立编译 Tailwind 样式，不依赖先构建工作台页面。

聊天前端检查：`npm run chat:check && npm run chat:test && npm run chat:build`。组件集成回归覆盖草稿保留、快捷键发送、Markdown 和命令输出折叠。后端与远程协议检查：`go test ./...`。远程对话回归使用独立测试进程，覆盖创建、512 个连续回复增量、审批、续聊和停止，不调用真实模型。
