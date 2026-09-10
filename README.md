# 银行回单工作台

> 0.1.27 公开发布准备版 · Windows x64 · 本地 PDF 查找、审核与导出

银行回单工作台是一款 Windows 桌面应用：从本机 PDF 中查找关键词，预览命中页面，复核和调整候选凭证范围，然后导出合并版或按来源拆分的 PDF，并可选生成 XLSX 审核索引。

[使用指南](docs/usage.md) · [开发指南](docs/development.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [第三方组件说明](THIRD_PARTY_NOTICES.md) · [发布清单](docs/release-checklist.md)

## 当前状态

这里是 0.1.27 的公开发布准备目录，不是已经发布的稳定版。项目许可路线已确定为 **AGPL-3.0-only**，根目录已加入对应的 AGPL-3.0 文本；GitHub 仓库已经创建，但源码尚未推送到 `main`。

本地整理范围、测试结果和未完成事项见[公开发布准备记录](docs/preparation-status.md)。

## 许可证与计划公开入口

本项目采用 AGPL-3.0-only 路线，根目录已加入对应的 AGPL-3.0 文本；PyMuPDF/MuPDF 按上游 AGPL 分发路线处理，公开发布时需随包保留相应源码、构建说明和许可文本，并继续核对 PaddleOCR/PaddlePaddle/PaddleX、Python、Rust 和前端依赖的分发条件。项目许可证不等于第三方依赖许可证；不能把整个安装包笼统称为 MIT。

已创建的 GitHub 仓库地址及待完成入口如下：

- 仓库：[https://github.com/flydommm/bank-receipt-workbench](https://github.com/flydommm/bank-receipt-workbench)（已创建）；
- 源码：[https://github.com/flydommm/bank-receipt-workbench/tree/main](https://github.com/flydommm/bank-receipt-workbench/tree/main)（等待源码推送）；
- Issues：[https://github.com/flydommm/bank-receipt-workbench/issues](https://github.com/flydommm/bank-receipt-workbench/issues)；
- Releases：[https://github.com/flydommm/bank-receipt-workbench/releases](https://github.com/flydommm/bank-receipt-workbench/releases)（尚未发布）。

仓库已创建但目前尚未推送源码，`main` 不应被描述为已有项目内容；Release 尚未发布，远程 CI 尚未运行。GitHub 私密漏洞报告功能和安全邮箱也尚未确认启用；敏感问题请先按 [安全说明](SECURITY.md) 保留最小合成复现，不要把细节写入公共 Issues。

公开发布前仍需完成以下事项：

- 核对根目录 `LICENSE`、项目元数据和公开说明均标识 AGPL-3.0-only，按 PyMuPDF/MuPDF 上游 AGPL 分发路线准备随包源码、构建说明和许可文本，并完成其他第三方依赖分发条件核对。
- 在真正干净的 Windows x64 环境完成 Core 与 OCR 安装、升级、卸载和首次运行验证。
- 决定是否提供代码签名；当前安装包没有签名证书。
- 将源码推送到已创建的 GitHub 仓库并验证 `main`、Issues、Releases 和源码入口；当前远程 CI 尚未执行。

## 能做什么

- 对带文字层的 PDF 进行精确或模糊关键词搜索。
- 对扫描 PDF 使用可选的本地 OCR 运行时搜索，并用识别文字和坐标辅助候选凭证定位。
- 在真实页面预览中检查候选框，手动调整、保留整页或确认裁剪范围。
- 按来源筛选和排序结果，批量应用经过检查的同类裁剪，并在任务内撤销最近的审核操作。
- 先生成最终 PDF 预览，再导出合并版、按来源输出的 PDF，或同时导出可选的 XLSX 审核索引。
- 持久保存任务、分页进度和审核状态，支持暂停、继续、停止以及从历史任务中明确载入。

应用没有独立的“另存为可搜索 PDF”入口。OCR 文字用于本地搜索、版面分析和临时处理，不会提供一个供用户另存的 OCR PDF。

## 本地处理与文件保护

PDF 处理在本机完成。应用不把 PDF 内容上传到云端服务，也没有在线反馈上传或自动更新服务。原始 PDF 以只读方式处理；任务数据库、临时文件、OCR 文字缓存和导出结果写在本机或用户选择的输出目录中。

OCR edition 首次初始化或首次识别时可能从模型提供方下载公开模型文件，因此首次使用需要网络。模型下载不等于上传用户 PDF；若组织环境禁止联网，应提前准备模型缓存并在帮助中心执行 OCR 检测。反馈窗口只在本机生成可复制或保存的文本，不会自动发送。

## 选择安装包 edition

| Edition | 适用材料 | 运行时内容 |
| --- | --- | --- |
| `Core` | 已有文字层的 PDF | 应用私有 Python 运行时和 PyMuPDF；不包含完整 OCR 依赖 |
| `Ocr` | 文字型和扫描 PDF | `Core` 内容加本地 PaddleOCR/PaddlePaddle 运行时；首次 OCR 可能下载模型 |

两种安装包使用同一应用标识，请选择其中一种安装；切换 edition 会更新同一个应用，并非同时安装两套独立软件。

安装包尚未在公开地址发布。维护者完成发布门槛并将源码推送到已创建的仓库后，应在 [GitHub Releases](https://github.com/flydommm/bank-receipt-workbench/releases) 中提供 edition、SHA-256 和对应的运行时清单；在此之前请不要把 `outputs/` 或本地构建目录当作下载源。

## 开发环境概览

开发和构建面向 Windows 10/11 x64，通常需要：

- Git；
- Bun 1.3 或更高版本；
- Rust/Cargo 的 MSVC 工具链；
- Python 3.12（运行 Python 测试以及 Rust 的引擎进程测试）；
- 可用的 Microsoft Edge WebView2 Runtime。安装器可能提示安装或修复它。

完整命令和常见故障处理见[开发指南](docs/development.md)。只想使用安装包时不需要在系统 Python 中安装项目依赖；安装包会使用应用私有运行时。

## 限制与使用边界

当前默认安全上限是每个 PDF 5,000 页、每次选择 500 个 PDF、每个 PDF 500 MiB。环境变量可以调整部分上限，但更高取值不代表已经通过性能或 OCR 验证。扫描件的识别准确率、候选框质量和耗时取决于版式、清晰度、页数和本机 CPU，低置信度结果仍需人工复核。

请先用脱敏或合成样本确认流程，再处理正式材料。不要把含真实账号、客户信息、文件路径、日志或私有 PDF 的文件提交到公开仓库、Issue、Pull Request 或测试夹具中。

## 目录速览

- `src/`：React 前端和领域逻辑。
- `engine/`：本地 Python PDF、搜索、OCR、审核与导出引擎。
- `src-tauri/`：Tauri 宿主、私有运行时装载和 Windows 文件操作边界。
- `tests/`：Python 合成数据测试；不依赖业务 PDF。
- `scripts/`：运行时准备和发布辅助脚本。

贡献前请先阅读[贡献指南](CONTRIBUTING.md)和[安全说明](SECURITY.md)。
