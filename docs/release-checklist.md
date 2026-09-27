# 0.1.57 发布清单

本文是可复用的 0.1.57 Windows x64 Core 公开预发布核对模板。这里的勾选只表示当前文档或代码范围已核对，不表示最终 Release 已完成；最新 CI 链接、主分支合并状态、产物哈希和安装包身份统一记录在 GitHub Release 正文及随包 `build-info.json` 中。源码 CI、资源核验和本机构建不能代替干净 Windows 安装。0.1.27 的资产与历史结论保留在[首次公开预发布记录](public-release-0.1.27.md)，不继承为 0.1.57 通过证据。

本次发布只准备 Core x64。0.1.57 不包含 OCR 运行时，因此本清单不把历史 OCR 包或旧版 OCR 测试写成当前版本范围。

## 公开仓库与隐私

- [ ] 已将当前脱敏源码分支合并到 `main`，且 `main` 中的版本、下载链接和发布说明均指向 0.1.57。
- [x] 根目录 `LICENSE`、package/Cargo/Tauri 元数据继续按 AGPL-3.0-only 对齐；许可证和第三方通知随发布材料交付。
- [ ] 对最终公开分支的可达 Git 历史、源码归档和 Release 资产完成敏感信息审计；真实 PDF、任务数据库、模型缓存、私有路径和原始开发历史不得进入公开仓库。
- [x] GitHub Issues、私密漏洞报告、贡献指南和第三方组件说明保留公开入口，不在文档中放置密钥、令牌或业务样本信息。
- [ ] 发布前复核所有新文档的相对链接和公开 URL，确保不把本地 `outputs/`、临时目录或私有工作树写成下载地址。

## 构建输入

- [ ] 在构建前确认工作树只包含已提交的公开改动，记录源码提交、构建时间、构建命令和工具版本。
- [ ] `bun install --frozen-lockfile` 成功，且安装没有生成未预期的跟踪文件。
- [ ] `python -m pip install --requirement engine/requirements-dev.txt` 成功，测试依赖与仓库文件一致。
- [ ] 核对 `engine/requirements-core-win-x64.lock`、`scripts/runtime-manifest.json` 和 `src-tauri/tauri.conf.json` 的资源路径；运行时准备只针对 Core 执行。
- [ ] 运行时准备和发布脚本使用干净的公开源码，不把真实银行 PDF、客户信息或任务数据库放入测试输入。

## GitHub 自动检查

以下命令与公开 CI 的核心检查保持一致；它们不启动真实业务 PDF，也不上传私有材料：

```powershell
bun install --frozen-lockfile
bun run build
bun run test:web
python -m pytest tests
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

- [ ] GitHub Actions 的 Windows 工作流全部成功，且最新成功运行对应当前准备发布的公开提交。
- [ ] 前端构建和 Vitest 通过，包含大批量候选缓存回归。
- [ ] Python pytest 通过，输入为合成数据或公开夹具。
- [ ] Rust 测试通过，`PDF_SEARCH_TEST_PYTHON` 指向可用的 Python 3.12。
- [ ] CI 日志确认未上传私有样本、不创建 Release、不把构建目录作为发布资产。

GitHub Actions 通过后，将具体运行链接写入 GitHub Release 正文；本页保持可复用检查项，不作为实时发布状态面板。

## 0.1.57 变更复核

- [x] 三阶段名称和流程为“导入预览 → 分析处理 → 导出结果”。
- [x] 添加来源后默认“分割全部回单”，需要关键词时再切换“查找提取回单”。
- [x] 原页总览和片段总览支持缩略图滚动、缩放、来源/类型筛选和多选批量操作。
- [x] 疑似需排除片段可独立筛选、批量排除和恢复；排除不删除或修改磁盘原件。
- [x] 特殊凭证可单个或批量确认，与普通回单分开处理，不能互相套用裁剪边界。
- [x] 普通回单可按所选栏位微调边界，并在需要时保存或更新版式模板；同一家银行可以保留多套模板，模板只复用已确认栏位。
- [x] 当前入口不保留历史任务；新任务不继承旧任务的审核、排除或特殊凭证状态。
- [x] 所有待复核清零后直接进入导出设置；XLSX 索引可选，清单 JSON 默认不勾选。
- [x] 本版包含排除隔离、单栏微调影响范围和浙商银行版式身份校验修复；这些修复仍须以自动化检查和发布构建证据闭环。

## 生成和核对安装包

- [ ] 所有拟发布改动已提交，工作树干净；构建期间保持同一提交且不编辑源码。
- [ ] 使用固定发布脚本构建 Core x64：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -Edition Core
  ```

- [ ] 构建记录包含版本 `0.1.57`、edition、源码提交、runtime manifest 摘要、构建命令、包大小和 SHA-256。
- [ ] `build-info.json` 中 `source_has_uncommitted_changes` 为 `false`，`clean_windows_verified` 按实际结果填写，`signed` 为 `false`，因为本版安装包未签名。
- [ ] 最终公开安装包名称为 `bank-receipt-workbench_0.1.57_core_x64-setup.exe`。
- [ ] 对最终安装包、源码 ZIP、构建记录和其他 Release 资产生成 `SHA256SUMS.txt`，并逐项核对发布前后哈希一致。
- [ ] 发布资产不包含真实业务 PDF、任务数据库、OCR 模型缓存、私有审计日志或本地绝对路径。

本地构建目录只用于内部核对；不将本地路径或中间产物写成公开下载链接。最终资产以 GitHub Release 页面为准。

## 干净 Windows 定向验收

这部分必须使用与构建机隔离的 Windows 10/11 x64 环境；已测试的旧版本不能替代 0.1.57 新安装包的结果。

- [ ] 记录系统版本、架构、WebView2 状态、DPI 和网络策略。
- [ ] 安装 0.1.57 Core：帮助与反馈显示 `v0.1.57`，应用能启动并停在导入预览阶段。
- [ ] 添加文字型 PDF，确认默认“分割全部回单”、默认原页总览、来源切换、上一页/下一页和缩放正常。
- [ ] 分析后分别检查普通回单、疑似需排除片段和特殊凭证；验证单个/批量排除、特殊凭证确认、边界微调和模板保存/选用/停用隔离。
- [ ] 确认旧任务审核结论、排除项和特殊凭证状态不会带入新任务；模板只复用已确认栏位。
- [ ] 待复核清零后选择导出方式和目录，验证 PDF 导出、可选 XLSX、默认关闭 JSON 清单以及原始 PDF 文件数量、字节数和 SHA-256 前后一致。
- [ ] 关闭并重新打开应用，验证当前版本的模板和关键词设置按设计保留，未出现历史任务入口。
- [ ] 覆盖升级、卸载和重新安装按实际策略验证；确认程序文件/快捷方式处理不误删用户明确保留的数据和原始 PDF。
- [ ] 记录本次未覆盖的范围：扫描 PDF/OCR、超大 PDF、GPU、非 Windows 平台、签名和性能基准。

## 发布决定

- [ ] 脱敏源码已合并到 `main`，并且 `main` 的源码版本和下载说明为 0.1.57。
- [ ] GitHub 自动检查全部成功；运行链接记录在 GitHub Release 正文和构建记录中。
- [ ] 0.1.57 Core 安装包、源码 ZIP、版本说明和 `SHA256SUMS.txt` 已发布到 [GitHub Releases](https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.57)。
- [ ] Release 标记为预发布，直到本版干净 Windows 定向验收完成；未签名状态已明确展示。
- [x] 私密漏洞报告入口和 AGPL-3.0-only 许可说明保持可访问。

最终发布以 GitHub Release 正文、Release Assets、`SHA256SUMS.txt` 和 `build-info.json` 为准；不要把旧版本人工测试或本地构建成功改写成 0.1.57 新包通过。
