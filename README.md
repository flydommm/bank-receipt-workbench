# 银行回单工作台

> 0.1.57 公开预发布 · Windows x64 · 本地 PDF 查找、审核与导出

**[下载安装包](#下载安装包windows) · [Releases / 全部版本](https://github.com/flydommm/bank-receipt-workbench/releases) · [使用指南](docs/usage.md) · [微调审核流程](docs/guided-review-workflow.md) · [问题反馈](https://github.com/flydommm/bank-receipt-workbench/issues)**

## 下载安装包（Windows）

0.1.57 当前提供 Core x64 安装包。点击下表中的下载链接即可获取安装包，无需在发布页展开 Assets。

| 安装包 | 适用情况 | 直接下载 |
| --- | --- | --- |
| **Core x64（当前版）** | 处理已有文字层的 PDF；包含本地 PDF 搜索、版面分析、审核和导出运行时 | **[下载 0.1.57 Core x64](https://github.com/flydommm/bank-receipt-workbench/releases/download/v0.1.57/bank-receipt-workbench_0.1.57_core_x64-setup.exe)** |

适用于 Windows 10/11 x64。关闭应用后运行下载的 `.exe`，安装器会使用应用自己的运行时，不需要在系统 Python 中安装项目依赖。0.1.57 Core 不包含 OCR 运行时，扫描型 PDF 的识别能力不属于本次安装包范围。

当前为 **0.1.57 公开预发布**，安装包未签名。GitHub 自动检查、最终资产和 SHA-256 以 [本版 Releases 页面](https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.57)及随包提供的 [`SHA256SUMS.txt`](https://github.com/flydommm/bank-receipt-workbench/releases/download/v0.1.57/SHA256SUMS.txt) 为准；0.1.57 新安装包的干净 Windows 定向验证须以本版实际安装结果记录，不能用旧版本结果代替。完整发布边界见[0.1.57 发布说明](docs/release-0.1.57.md)。

## 应用介绍

银行回单工作台是一款 Windows 桌面应用：在本机 PDF 中查找或分割回单，预览原页和片段，人工审核、调整边界，再导出合并版或按来源拆分的 PDF，并按需生成 XLSX 索引或 JSON 清单。项目采用 [AGPL-3.0-only](LICENSE)。

应用按三个阶段组织操作：**导入预览 → 分析处理 → 导出结果**。

1. **导入预览**：添加 PDF 后默认选择“分割全部回单”，并默认显示原页总览；需要按关键词筛选时再切换到“查找提取回单”。原页缩略图支持滚动、缩放和来源切换。
2. **分析处理**：分析后在片段总览或原页总览中筛选结果。先处理疑似需排除的片段，再确认特殊凭证；普通回单可进行边界微调、复核确认并按需保存或更新版式模板。片段支持单选、当前筛选结果多选和批量处理。
3. **导出结果**：所有未排除的待复核片段完成处理后，选择导出方式和目录即可导出。导出范围包含自动候选和已确认的保留片段，不包含排除片段。

新手可以先看[使用指南](docs/usage.md)；需要调整候选框时再看[微调审核流程](docs/guided-review-workflow.md)。本版以文字型 PDF 的本地处理为交付范围。

[源码](https://github.com/flydommm/bank-receipt-workbench/tree/main) · [Issues](https://github.com/flydommm/bank-receipt-workbench/issues) · [Releases](https://github.com/flydommm/bank-receipt-workbench/releases) · [开发指南](docs/development.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [反馈维护说明](docs/feedback-maintenance.md) · [第三方组件说明](THIRD_PARTY_NOTICES.md)

## 当前状态

0.1.57 是从已脱敏公开源码构建的 Core x64 预发布版本。发布前必须完成 GitHub 自动检查，并将最终构建的安装包、源码归档、发布说明和 SHA-256 清单绑定到同一公开版本；发布记录见[0.1.57 发布说明](docs/release-0.1.57.md)。本版不把本地构建、源码测试或旧版人工验收写成新安装包的干净 Windows 通过证据。

当前公开仓库不保留“历史任务”入口。用户可以在“我的模板”中管理同一家银行的多套版式模板；模板保存已核对的边界，可供同银行、同凭证类型和同实际版式的新任务匹配或手动选用。模板不会把旧任务的审核结论、排除决定或特殊凭证状态带入新任务。

旧版本的交付记录和人工测试资料仍作为历史资料保留，例如 [0.1.27 首次公开预发布记录](docs/public-release-0.1.27.md)；其中的版本、资产和验收结论不适用于 0.1.57。

## 能做什么

- 对带文字层的 PDF 进行精确或模糊关键词搜索，并按关键词提取命中回单。
- 默认将原页按识别到的回单边界分割为片段；“分割全部回单”模式下也会保留每个来源的全部候选，不因没有关键词而跳过审核。
- 用原页总览和片段总览快速查看大批量材料；缩略图支持调整大小，片段支持当前筛选范围的多选、批量确认、批量排除和恢复。
- 对疑似无效片段提供独立筛选和批量排除；排除只影响当前任务和导出范围，不删除或修改磁盘上的原始 PDF。
- 对可能的贷款通知书、缴税凭证等特殊凭证提供识别提示和凭证类型确认。特殊凭证与普通回单分开处理，互不套用错误的裁剪边界。
- 普通回单可以在分析后调整所选栏位边界；单栏微调只影响明确选择的栏位，边界变化会重新提示受影响的片段复核。
- 按银行管理多套版式模板。每套模板可以独立命名、更新、停用；同一家银行不论处理哪家公司，都可以按实际版式保存多套模板。模板只复用已确认的边界，未确认栏位仍需人工复核。
- 分析处理完成后直接进入导出设置，不需要重复生成一份导出前预览。可以导出合并 PDF、按来源输出的 PDF，并可选导出审核索引 XLSX；清单 JSON 默认不勾选，需要复盘时再启用。

所有未排除的待复核片段清零前不会显示导出入口。查看筛选范围只改变当前视图，不会悄悄扩大或缩小导出范围；导出前仍会重新校验审核状态和模板边界。

## 本地处理与文件保护

PDF 搜索、版面分析、审核和导出在本机完成。应用不把 PDF 内容上传到云端服务，也不提供后台反馈上传或自动更新服务。原始 PDF 以只读方式处理；任务数据库、临时文件和导出结果写在本机或用户选择的输出目录中。

安装器可能提示安装或修复 Microsoft WebView2 Runtime。WebView2 属于微软运行时，有独立的更新和数据处理行为；本项目不将其描述为完全离线组件。

反馈窗口先在本机生成预览，用户主动选择邮件或 GitHub 入口时才会打开外部客户端或网页；应用不会自动上传、提交 Issue 或发送消息。分享反馈前请删除路径、客户名称、账号、文件名等敏感内容。

## 反馈渠道

在“帮助与反馈”的“03 使用反馈”中，用户可以生成反馈预览、复制内容或保存 TXT。需要联系维护者时，可按下面的方式操作：

- **邮件**：点击“复制反馈并写邮件”，应用会先复制预览，再打开默认邮件客户端，收件人为 `venz@163.com`。用户需要在邮件正文粘贴、检查并自行发送；维护者通过原邮件回复。
- **GitHub Issues**：点击“复制反馈并打开 GitHub”，应用会先复制预览，再打开[新建 Issue 页面](https://github.com/flydommm/bank-receipt-workbench/issues/new)。用户需要登录 GitHub、粘贴并检查内容后自行提交；维护者在同一条 Issue 中回复。
- **微信**：添加微信号 `vinz2009` 后发送反馈。应用只展示或复制微信号，不会自动添加好友或发送消息；维护者通过微信回复。

这些入口只负责复制预览和打开用户选择的外部应用或网页，不会把 PDF、日志或附件上传，也不会替用户发送邮件或提交 Issue。邮件客户端不可用、GitHub 需要登录或网络不可用时，可以回到预览手工复制，或保存 TXT 后在外部渠道粘贴。

## 选择安装包 edition

| Edition | 适用材料 | 运行时内容 |
| --- | --- | --- |
| `Core` | 已有文字层的 PDF | 应用私有 Python 运行时和 PyMuPDF；不包含 OCR 依赖 |

0.1.57 当前只发布 Core x64。历史版本的 OCR 资产仍可在对应旧版 Release 中查看，但不属于 0.1.57 的下载推荐，也不能据此推断本版支持扫描 PDF。

公开安装包文件名为 `bank-receipt-workbench_0.1.57_core_x64-setup.exe`。构建记录、运行时清单、第三方组件清单和许可证通知由发布资产提供；实际下载和公开状态以 [GitHub Releases](https://github.com/flydommm/bank-receipt-workbench/releases) 为准。请不要把 `outputs/` 或本地构建目录当作下载源。

## 开发环境概览

开发和构建面向 Windows 10/11 x64，通常需要：

- Git；
- Bun 1.3 或更高版本；
- Rust/Cargo 的 MSVC 工具链；
- Python 3.12（运行 Python 测试以及 Rust 的引擎进程测试）；
- 可用的 Microsoft Edge WebView2 Runtime。

完整命令和常见故障处理见[开发指南](docs/development.md)。只想使用安装包时不需要在系统 Python 中安装项目依赖；安装包会使用应用私有运行时。

## 限制与使用边界

当前默认安全上限是每个 PDF 5,000 页、每次选择 500 个 PDF、每个 PDF 500 MiB。环境变量可以调整部分上限，但更高取值不代表已经通过性能验证。低置信度边界、特殊凭证和疑似排除片段仍需人工确认；不同银行或版式的模板不能仅凭栏数相同而互相套用。

请先用脱敏或合成样本确认流程，再处理正式材料。不要把含真实账号、客户信息、文件路径、日志或私有 PDF 的文件提交到公开仓库、Issue、Pull Request 或测试夹具中。

## 目录速览

- `src/`：React 前端和领域逻辑。
- `engine/`：本地 Python PDF、搜索、版面分析、审核与导出引擎。
- `src-tauri/`：Tauri 宿主、私有运行时装载和 Windows 文件操作边界。
- `tests/`：Python 合成数据测试；不依赖业务 PDF。
- `scripts/`：运行时准备和发布辅助脚本。

贡献前请先阅读[贡献指南](CONTRIBUTING.md)和[安全说明](SECURITY.md)。
