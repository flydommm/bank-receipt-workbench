# 开发指南

本文描述在 Windows x64 上构建和验证 0.1.27 准备版的最短路径。命令都从项目根目录执行；不要在系统目录执行。

版式设置与批量提取的实施资料：[完整设计](receipt-layout-design.md)、[实施 TODO](receipt-layout-todo.md)、[验收矩阵](receipt-layout-acceptance.md)。新领域模型、共用引擎和内部持久化已分阶段接入；桌面新流程尚未开放，各阶段以 TODO 的实际证据为准。

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

Core 和 Ocr 共用 `.build/runtime`，切换 edition 会重新生成运行时；不要把一次运行的 NSIS 包与另一次运行的 runtime 清单混用。记录目录为 `outputs/releases/<版本>-<core或ocr>-<源码提交前12位>/`，包含根目录 `LICENSE`、第三方声明和源码提交地址。同一提交与 edition 的已有交付目录不会被覆盖；新提交使用独立目录，保留此前交付记录。

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

后台页面核验使用 `engine_inspect_pages` / `inspect_pages`，每次一个来源、最多 32 个唯一页码。每批只建立一次 SHA 绑定的私有工作副本并打开一次 PDF；逐页核验真实尺寸和 144 DPI 像素预算，不生成 PNG。可见页面继续使用前台渲染；这项核验不代表所有页面都已实际渲染成功，导出仍独立复核来源、页数和最终裁剪范围。微调需要时附带版式描述，前端缓存绑定任务、分析代次、来源 SHA、页码和是否包含版式；重新分析或来源变化会清空。

`receipt_image_issuer.py` 仅对标题附近、大小受限的独立图片页眉进行本地 OCR。结果必须通过银行标题规范、置信度和账户字段排除；缓存复用现有私有 OCR 缓存的校验、容量、过期和清理规则。业务图片及其具体内容哈希不登记进源码。计算版本包含该模块，升级后旧分析需要重新计算。

Windows 桌面启动验收必须覆盖真实的资源解析和进程启动器。资源安全检查使用规范路径，但启动 Python 前还需核实并转换为等价的普通绝对路径；直接用带 `\\?\` 的解释器路径会使 `sys.prefix` 带上同样前缀，Paddle 读取含 `..` 的 native 依赖路径时可能报 `WinError 123`。只运行开发解释器、普通命令行或检查 OCR 依赖已安装不能验证这一分支。桌面运行时契约也计入计算版本，修复启动行为后旧候选需重新分析。

准备 OCR 资源后，可执行真实桌面启动链的合成识别测试（普通测试默认跳过；复用本机模型，缺少时可能下载公开模型）：

```powershell
$env:PDF_SEARCH_TEST_RUNTIME_ROOT = (Resolve-Path 'src-tauri/target/x86_64-pc-windows-msvc/release').Path
cargo test --manifest-path src-tauri/Cargo.toml --locked bundled_ocr_health_runs_through_the_desktop_process_spec -- --ignored
```

多联来源参考页优先覆盖不同回单标题，仍受扫描页数和版式描述数量上限约束。已核实银行及版式的某一栏可证明相同尾页应按单张分割；其他栏身份未知时，只允许这种正向匹配，不能据此把未匹配尾页判为原生单张。视觉边框之间的分割线同时受当前回单最后一行文字与下一张抬头约束，保留边框外页脚；证据不足仍交由人工复核。

`receipt_headers.py` 为自动候选和微调保护边界共享纯几何抬头识别，处理独立完整行或拆分标签、数值的打印次数标记。保留标题距离、唯一配对和工作量上限，不改动原始可搜索文字块；歧义标记仍按普通正文处理，不能靠匹配关键词推断抬头归属。

- `src/` 负责工作台界面、搜索条件、审核状态、导出范围和持久任务控制。
- `src-tauri/` 负责 Windows 选择器、私有 Python 进程、SQLite 任务数据和受控文件操作。
- `engine/` 负责 PDF 解析、文字搜索、OCR、缓存、候选框分析、审核和导出。
- 原始 PDF 必须保持只读；任何新输出都写到新文件或用户选择的目录。
- OCR 文字和坐标可能属于敏感业务数据，日志、错误文本和反馈预览不能泄露正文、账号、路径或模型输入。

涉及结果算法、协议、运行时依赖、资源清单或数据清理时，请同时更新对应测试和发布清单，并在 Pull Request 中说明验证范围。不要把“能在当前开发机启动”写成“已在干净 Windows 安装通过”。

## 批量预览的界面更新回归

回单版式改造的内部持久任务已新增页面 schema 2 和审核上下文 version 3。任务数据库升级、零命中页检查点、实例身份、发布时重建比对及兼容边界见[领域与持久化合同](receipt-layout-contract.md#内部持久任务与快照)。内部审核使用独立 receipt 记录表，支持基于权威清单的批量保存、旧任务记录隔离、只读恢复和归属清理；普通裁剪仍不能越过原候选框，整版校准将通过独立预览事务接入。宿主、前端和导出接线尚未完成，不提前广播全部分割能力或把内部调用测试视为桌面验收。旧任务继续读取原 schema 1 数据，不因关键词为空转成全部分割。

批量分析和微调预览会连续更新进度，缓存命中时多个更新可能处于同一轮微任务中。文件列表应在勾选路径确实失效时才写入选择状态；不要在每次 `files` 数组变化后无条件调用 setter，再仅在 updater 内返回原值。在生产 React 和原生鼠标点击的同步优先级下，这种无效更新与进度更新交错曾触发 `Maximum update depth exceeded`（错误码 185）。

验证此路径需覆盖生产 React、超过 50 次缓存进度更新和真实的文件列表组件。只有少量候选的测试，或测试框架将所有更新合并到一次 `act` 中，不能证明该场景通过。整轮交互同时检查：确认后可以浏览其他页的联动框、预览阶段没有保存写入、返回调整后可以重新预览，以及保存时一次提交本轮全部片段。
