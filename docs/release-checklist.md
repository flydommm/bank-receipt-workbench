# 0.1.27 发布清单

本文是 Windows x64 安装包的发布检查表。0.1.27 按 `v0.1.27-pre.1` 预发布交付，源码已公开；项目采用 AGPL-3.0-only。勾选项表示本次已有证据，未勾选的干净 Windows 验收仍需补齐，不能以源码 CI 或本机构建代替。下次发布应按新输入重新核对相关项目。

本次公开预发布与首次 Windows CI 已完成，资产和证据见[公开预发布记录](public-release-0.1.27.md)。

## 公开仓库门槛

- [x] 向独立公开仓库推送已脱敏的源码。入口：[源码](https://github.com/flydommm/bank-receipt-workbench/tree/main)、[Issues](https://github.com/flydommm/bank-receipt-workbench/issues)、[Releases](https://github.com/flydommm/bank-receipt-workbench/releases)。原私有开发历史没有推送。
- [x] 根目录 `LICENSE`、package/Cargo/Tauri 元数据按 AGPL-3.0-only 对齐，许可证随两种安装包交付，对应源码提交已公开。
- [x] 准备对应源码 ZIP、构建说明、上游来源和原始许可文本；第三方清单记录精确版本与校验值。此项是材料核对，不是独立法律审查结论。
- [x] 复核第三方通知、版权文本及模型分发边界；安装包不含模型权重，首次模型下载验证另列在手工验收中。
- [x] GitHub 私密漏洞报告已启用并通过 API 核验，入口见 [SECURITY.md](../SECURITY.md)。
- [x] 扫描公开文件、可达 Git 历史及发布附件；配置规则和本地敏感词扫描零命中。扫描不保证发现所有隐私问题，真实样本及原私有历史始终排除。
- [x] 文档使用仓库相对链接及真实公开 URL；本机构建目录只用于开发说明，不作为公开下载链接。

## 构建输入

- [x] 在 Windows x64 构建机确认 Git、Bun 1.3+、Rust/Cargo MSVC 工具链、PowerShell 和 Python 3.12 可用。
- [x] `bun install --frozen-lockfile` 成功，且工作树没有因安装生成的未预期文件。
- [x] `python -m pip install --requirement engine/requirements-dev.txt` 成功，测试依赖版本与仓库文件一致。
- [x] 核对 `engine/requirements-core-win-x64.lock`、`engine/requirements-ocr-win-x64.lock`、`scripts/runtime-manifest.json` 和 `src-tauri/tauri.conf.json` 资源路径；发布脚本会按 edition 调用带 `-Rebuild` 的运行时准备。
- [x] 运行时准备只按一个 edition 一次执行；Core 构建完成后先保存安装包、runtime manifest 和校验记录，再切换 Ocr。两种 edition 共用 `.build/runtime`，不能直接连续执行并假定前一个仍在。
- [x] 用当前 edition 的私有解释器运行 `scripts/smoke-runtime.py`，确认合成 PDF 的搜索、预览、裁剪导出和原始文件未变化；不要把真实 PDF 传给该脚本。

  ```powershell
  $privatePython = '.\.build\runtime\python\python.exe'
  & $privatePython -B -I -X utf8 .\scripts\smoke-runtime.py --resource-root .
  ```
- [x] 记录源码提交、构建时间、构建命令和构建机工具版本；删除或隔离不属于本次构建的 `.build/`、`dist/` 和 `target/` 内容。

## 自动化验证

以下命令与公开 CI 保持一致，不启动真实业务 PDF 或自动发布：

```powershell
bun run build
bun run test:web
python -m pytest tests
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

- [x] 前端构建和 Vitest 通过。
- [x] Python pytest 通过，输入为合成数据或公开夹具。
- [x] Rust 测试通过，且 `PDF_SEARCH_TEST_PYTHON` 指向 Python 3.12。
- [x] CI 只执行源码验证，不上传私有样本、不构建发布产物、不创建 GitHub Release。

## 生成和核对安装包

- [x] 拟发布改动全部提交，工作树干净；构建期间保持同一提交且不编辑源码。发布脚本会在构建前后强制核对。
- [x] 使用发布脚本固定的 Windows x64 产物路径及本次生成时间核对，手工调试构建不能单独作为发布验收证据。

优先使用发布脚本；它会调用运行时准备和公共树审查，构建 NSIS，并把 edition、源码提交、包大小、SHA-256 和 runtime manifest 保存到本地记录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Core
```

- [x] Core 构建完成，本地记录包含带 `core` 标记的资产和对应 runtime manifest。
- [x] 先保存 Core 本地资产和记录，再执行 Ocr：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Ocr
  ```

- [x] Ocr 构建完成，本地记录包含带 `ocr` 标记的资产和对应 runtime manifest。
- [x] Core/Ocr 共用 `.build/runtime`；切换 edition 后不得拿新的 runtime 清单解释旧的安装包。
- [x] 对 `build-release.ps1` 复制到本地记录目录的实际 `.exe` 运行以下命令，保存文件名、字节数和 SHA-256：

  ```powershell
  $version = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
  $edition = 'core'  # 核对 Ocr 包时改为 'ocr'
  $sourceCommit = (git rev-parse HEAD).Trim()
  # 若当前 HEAD 仅更新过交付文档，应改用安装包 build-info.json 中的 source_commit。
  $recordDir = ".\outputs\releases\$version-$edition-$($sourceCommit.Substring(0, 12))"
  Get-Item "$recordDir\*.exe" |
    Select-Object FullName, Length
  Get-FileHash "$recordDir\*.exe" -Algorithm SHA256
  Get-Content "$recordDir\build-info.json"
  ```

- [x] 构建记录包含源码提交、runtime manifest 摘要、构建命令、edition、包大小和 SHA-256。
- [x] `build-info.json` 中 `source_has_uncommitted_changes` 为 `false`，`clean_windows_verified` 和 `signed` 按实际状态填写；本地构建记录不会被当作公开下载链接。
- [x] 安装包没有签名时，明确标注“未签名”，不把构建成功写成签名或安全发布。

后续签名接入另见 [Code signing policy（准备稿）](code-signing-policy.md)与[SignPath 申请评估](signpath-assessment-2026-09-12.md)。这些准备文件不表示已有证书；现有 CI 与安装包签名状态保持不变。

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

- [x] 项目许可、对应源码、构建说明与第三方许可材料已按本次构建记录核对，见 [AGPL 交付记录](delivery-0.1.27-agpl.md)。
- [ ] Core/Ocr 安装、升级、卸载和首次 OCR 均在干净 Windows 上通过。
- [x] `main` 含有经核对的源码，Release 资产、SHA-256、变更说明和安全入口已准备；实际公开状态见 [Releases](https://github.com/flydommm/bank-receipt-workbench/releases)。
- [x] 私密漏洞报告已启用并验证，不用公共 Issues 接收敏感漏洞细节。
- [x] 公开说明安装包未签名及哈希核验方法。
- [x] 维护者已批准创建公开仓库并发布，当前只标记预发布，不将未完成干净环境验证的二进制标记为稳定版。

CI 的职责到此为止：它验证前端、Python 合成测试和 Rust 测试，不替代干净系统验收，也不自动上传或发布安装包。
