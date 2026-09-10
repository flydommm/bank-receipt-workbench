# 开发指南

本文描述在 Windows x64 上构建和验证 0.1.27 准备版的最短路径。命令都从项目根目录执行；不要在系统目录执行。

## 前置条件

- Windows 10/11 x64；
- Git；
- Bun 1.3 或更高版本；
- Rust stable 的 MSVC 工具链和 Cargo；
- Python 3.12 x64；
- PowerShell；
- 可用的 WebView2 Runtime。

先确认工具可见：

```powershell
bun --version
python --version
rustc --version
cargo --version
```

Rust 的 Python 进程测试要求实际使用 Python 3.12。若机器上有多个 Python，运行测试前显式设置 `PDF_SEARCH_TEST_PYTHON`。

## 安装前端依赖

```powershell
bun install --frozen-lockfile
```

公开测试使用仓库内锁定的开发依赖；不必为了运行单元测试安装完整 OCR 运行时：

```powershell
python -m pip install --requirement engine/requirements-dev.txt
```

`engine/requirements-dev.txt` 当前固定 PyMuPDF 1.28.2、pytest 8.4.2、numpy 2.3.5、Pillow 12.3.0 和 openpyxl 3.1.5。完整 OCR 运行时由发布准备脚本按 edition 处理。直接把 OCR 依赖装进系统 Python 会产生较大的 native 依赖和模型配置，除非你明确在做 OCR 兼容性验证，否则请使用下文的运行时准备流程。

## 本地开发

只调试 React 界面时：

```powershell
bun run dev
```

需要启动 Tauri 桌面窗口时，先准备应用私有 Core 运行时，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1 -Edition Core -Rebuild
bun run tauri dev
```

开发模式保留原有系统 Python 启动方式：Windows 需要受信任的系统 `py.exe -3.12`，并在该解释器安装开发依赖；准备 Core 运行时是资源构建前置步骤。正式 release 安装包只使用自带解释器，不回退到全局 Python。若要调试 OCR，也需为开发用 Python 显式安装 `engine/requirements-ocr.txt`；发布 OCR 包则使用 `-Edition Ocr`。模型和临时文件只留在本机。

## 验证命令

前端类型检查和生产构建：

```powershell
bun run build
```

前端测试：

```powershell
bun run test:web
```

Python 测试使用 pytest，测试中的 PDF 和 OCR 输入均为合成数据或受控夹具：

```powershell
python -m pytest tests
```

Rust 测试包括 Windows 进程边界测试。先把当前 Python 解释器的绝对路径传给测试，再运行 Cargo：

```powershell
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

只检查 Rust 编译：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

这些测试不需要真实业务 PDF、不启动 OCR 模型，也不上传样本。若要做真实 PDF 或干净系统验证，使用脱敏材料和独立机器，并把结果记录在发布清单中，不把材料复制进仓库。

## 私有运行时冒烟检查

准备好某个 edition 的 `.build/runtime/python` 后，可以用应用私有解释器运行合成数据冒烟检查。它会在临时目录生成非业务 PDF，检查搜索、页面预览、裁剪导出和原始文件未变化：

```powershell
$privatePython = '.\.build\runtime\python\python.exe'
& $privatePython -B -I -X utf8 .\scripts\smoke-runtime.py --resource-root .
```

需要检查 OCR 运行时和模型时再显式添加 `--ocr`；这一步可能下载公开模型，不应在普通前端或 Python 单元测试中隐式触发。

## 准备应用私有运行时

发布包不依赖用户系统 Python，而是把固定的应用私有 Python 3.12.14 Windows x64 运行时装入 Tauri 资源。当前计划提供两个 edition：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1 -Edition Core -Rebuild
```

`Core` 应包含 PyMuPDF，`Ocr` 在此基础上包含完整 PaddleOCR/PaddlePaddle/PaddleX 运行时。脚本会生成受 `.gitignore` 保护的 `.build/` 内容；它会校验固定 Python 发行包和 hash 锁定的 Windows x64 wheel，并可能联网下载这些构建输入。脚本默认拒绝覆盖已有运行时，重新生成必须显式使用 `-Rebuild`。Core 和 Ocr 共用 `.build/runtime`，切换 edition 会覆盖上一 edition；必须先保存上一 edition 的安装包、runtime manifest 和校验记录，再执行下一条命令。

保存 Core 安装包和记录后，再单独执行 Ocr 的运行时准备：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1 -Edition Ocr -Rebuild
```

脚本的参数或输出目录如果在后续版本调整，应同步更新本文件和发布清单。不要手工把系统 Python 目录复制到安装包，也不要把模型缓存、`.venv/`、`.build/` 或安装器产物提交到 Git。

## 构建 Windows NSIS 安装包

发布脚本要求所有拟发布改动已经提交，且工作树干净。构建开始与结束都会核对同一提交；构建期间不要编辑源码。脚本固定 Windows x64 目标目录并检查安装包是本次生成，避免把旧包记成新提交。

下面的手工 `prepare-runtime.ps1 + bun run tauri build` 路径仅供调试，不执行完整发布门槛，不能单独作为发布验收证据。

发布构建优先使用 `scripts/build-release.ps1`。它会按 edition 调用运行时准备、执行公共树审查、构建 NSIS、保存带 edition 的本地资产，并写入包大小、SHA-256、源码提交和运行时清单。命令从项目根目录执行：

构建也会收集前端生产依赖和 Windows Rust 解析依赖的原始许可文本，缺失时停止。备用上游文本在 `third-party/licenses/` 中固定版本、来源提交和校验值，升级依赖时需同步复核。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Core
```

构建 OCR 安装包时，先保存 Core 的本地资产和记录，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Ocr
```

Core 和 Ocr 共用 `.build/runtime`，切换 edition 会重新生成运行时；不要把一次运行的 NSIS 包与另一次运行的 runtime 清单混用。每个版本和 edition 的本地记录目录只能创建一次，已有记录时应先人工保存或清理确认过的构建状态，再开始新的版本构建。

脚本生成的本地资产位于受 `.gitignore` 保护的 `outputs/` 下，不是公开下载地址。若只需要手工调试构建，可分别执行：

```powershell
bun install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1 -Edition Core -Rebuild
bun run tauri build --bundles nsis --target x86_64-pc-windows-msvc
```

成功后，未自定义 `CARGO_TARGET_DIR` 时，上述 Windows x64 构建的 NSIS 包位于：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

不要只看构建成功。使用 `Get-Item` 和 `Get-FileHash -Algorithm SHA256` 记录确切文件名、字节数、SHA-256、edition、源码提交和运行时清单，随后执行发布清单中的安装、升级、卸载和首次 OCR 检查。`target/`、`dist/`、`.build/`、`outputs/` 和 `.artifacts/` 都是本地生成物，不应作为公开文档链接目标。

## 代码边界

- `src/` 负责工作台界面、搜索条件、审核状态、导出范围和持久任务控制。
- `src-tauri/` 负责 Windows 选择器、私有 Python 进程、SQLite 任务数据和受控文件操作。
- `engine/` 负责 PDF 解析、文字搜索、OCR、缓存、候选框分析、审核和导出。
- 原始 PDF 必须保持只读；任何新输出都写到新文件或用户选择的目录。
- OCR 文字和坐标可能属于敏感业务数据，日志、错误文本和反馈预览不能泄露正文、账号、路径或模型输入。

涉及结果算法、协议、运行时依赖、资源清单或数据清理时，请同时更新对应测试和发布清单，并在 Pull Request 中说明验证范围。不要把“能在当前开发机启动”写成“已在干净 Windows 安装通过”。
