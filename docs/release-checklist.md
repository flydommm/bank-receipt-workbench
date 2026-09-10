# 0.1.27 发布清单

本文是 Windows x64 安装包的发布前检查表。当前版本仍处于公开发布准备阶段；未完成许可证、干净 Windows 验证、仓库归属和代码签名决定前，不应把任何本地安装包称为正式公开稳定版。

## 公开仓库门槛

- [ ] 确认 GitHub owner/repo，并把 README、Issue、Release 和安全报告入口改成真实可访问地址。
- [ ] 选择项目许可证，获得必要授权后创建根目录 `LICENSE`；在此之前不宣称 MIT 或其他许可证。
- [ ] 明确 PyMuPDF 的 AGPL 或商业许可路径，并核对 PaddleOCR/PaddlePaddle/PaddleX、Python 和 Rust 依赖的分发条件。
- [ ] 复核第三方通知、版权文本、模型下载与分发边界。
- [ ] 扫描待公开文件、Git 历史和其他 refs，不含真实公司/用户资料、账号、令牌、个人绝对路径、私有 PDF、任务数据库、日志或本地交付记录。
- [ ] 检查 README、文档和工作流只使用相对路径或真实公开 URL，不链接 `outputs/`、`.artifacts/`、`.build/`、`target/` 或其他只存在于维护者电脑的文件。

## 构建输入

- [ ] 在 Windows x64 构建机确认 Git、Bun 1.3+、Rust/Cargo MSVC 工具链、PowerShell 和 Python 3.12 可用。
- [ ] `bun install --frozen-lockfile` 成功，且工作树没有因安装生成的未预期文件。
- [ ] `python -m pip install --requirement engine/requirements-dev.txt` 成功，测试依赖版本与仓库文件一致。
- [ ] 核对 `engine/requirements-core-win-x64.lock`、`engine/requirements-ocr-win-x64.lock`、`scripts/runtime-manifest.json` 和 `src-tauri/tauri.conf.json` 资源路径；发布脚本会按 edition 调用带 `-Rebuild` 的运行时准备。
- [ ] 运行时准备只按一个 edition 一次执行；Core 构建完成后先保存安装包、runtime manifest 和校验记录，再切换 Ocr。两种 edition 共用 `.build/runtime`，不能直接连续执行并假定前一个仍在。
- [ ] 用当前 edition 的私有解释器运行 `scripts/smoke-runtime.py`，确认合成 PDF 的搜索、预览、裁剪导出和原始文件未变化；不要把真实 PDF 传给该脚本。

  ```powershell
  $privatePython = '.\.build\runtime\python\python.exe'
  & $privatePython -B -I -X utf8 .\scripts\smoke-runtime.py --resource-root .
  ```
- [ ] 记录源码提交、构建时间、构建命令和构建机工具版本；删除或隔离不属于本次构建的 `.build/`、`dist/` 和 `target/` 内容。

## 自动化验证

以下命令与公开 CI 保持一致，不启动真实业务 PDF 或自动发布：

```powershell
bun run build
bun run test:web
python -m pytest tests
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

- [ ] 前端构建和 Vitest 通过。
- [ ] Python pytest 通过，输入为合成数据或公开夹具。
- [ ] Rust 测试通过，且 `PDF_SEARCH_TEST_PYTHON` 指向 Python 3.12。
- [ ] CI 只执行源码验证，不上传私有样本、不构建发布产物、不创建 GitHub Release。

## 生成和核对安装包

- [ ] 拟发布改动全部提交，工作树干净；构建期间保持同一提交且不编辑源码。发布脚本会在构建前后强制核对。
- [ ] 使用发布脚本固定的 Windows x64 产物路径及本次生成时间核对，手工调试构建不能单独作为发布验收证据。

优先使用发布脚本；它会调用运行时准备和公共树审查，构建 NSIS，并把 edition、源码提交、包大小、SHA-256 和 runtime manifest 保存到本地记录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Core
```

- [ ] Core 构建完成，本地记录包含带 `core` 标记的资产和对应 runtime manifest。
- [ ] 先保存 Core 本地资产和记录，再执行 Ocr：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Ocr
  ```

- [ ] Ocr 构建完成，本地记录包含带 `ocr` 标记的资产和对应 runtime manifest。
- [ ] Core/Ocr 共用 `.build/runtime`；切换 edition 后不得拿新的 runtime 清单解释旧的安装包。
- [ ] 对 `build-release.ps1` 复制到本地记录目录的实际 `.exe` 运行以下命令，保存文件名、字节数和 SHA-256：

  ```powershell
  $version = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
  $edition = 'core'  # 核对 Ocr 包时改为 'ocr'
  $recordDir = ".\outputs\releases\$version-$edition"
  Get-Item "$recordDir\*.exe" |
    Select-Object FullName, Length
  Get-FileHash "$recordDir\*.exe" -Algorithm SHA256
  Get-Content "$recordDir\build-info.json"
  ```

- [ ] 构建记录包含源码提交、runtime manifest 摘要、构建命令、edition、包大小和 SHA-256。
- [ ] `build-info.json` 中 `source_has_uncommitted_changes` 为 `false`，`clean_windows_verified` 和 `signed` 按实际状态填写；本地构建记录不会被当作公开下载链接。
- [ ] 安装包没有签名时，明确标注“未签名”，不把构建成功写成签名或安全发布。

## 干净 Windows 手工验收

使用与构建机隔离的 Windows 10/11 x64 机器或干净虚拟机；不要用已有开发环境代替此项。

- [ ] 记录系统版本、架构、WebView2 状态和网络策略。
- [ ] 安装 Core 包：启动应用、选择合成文字型 PDF、搜索、预览、调整候选框、确认并导出 PDF；核对原始 PDF SHA-256 未变化。
- [ ] 安装 Ocr 包：在不安装系统 Python 的前提下启动应用，点击“检测 OCR”，使用合成扫描页验证 OCR 搜索、候选框和导出；记录首次模型下载行为和失败提示。
- [ ] 关闭并重新打开应用，确认任务历史、暂停/继续和 OCR 缓存行为符合说明。
- [ ] 测试同名输出不会覆盖既有文件，清理任务/缓存不会删除原始 PDF 或已导出文件。
- [ ] 逐步验证升级、卸载和快捷方式；确认卸载流程不误删用户原始文件、导出目录或任务中仍需保留的数据。
- [ ] 记录未覆盖的范围：真实银行格式、超大 PDF、GPU、非 Windows 平台、OCR 准确率和性能。

## 发布决定

- [ ] 项目许可证和第三方依赖许可已获得明确结论。
- [ ] Core/Ocr 安装、升级、卸载和首次 OCR 均在干净 Windows 上通过。
- [ ] 公开仓库、Release 资产、SHA-256、变更说明和安全入口已准备。
- [ ] 代码签名已配置，或公开说明当前包未签名及用户核验方法。
- [ ] 维护者明确批准后，才创建 Release、上传安装包或把同一二进制标记为稳定版。

CI 的职责到此为止：它验证前端、Python 合成测试和 Rust 测试，不替代干净系统验收，也不自动上传或发布安装包。
