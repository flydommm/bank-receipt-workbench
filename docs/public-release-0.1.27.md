# 0.1.27 首次公开预发布记录

日期：2026-09-11。版本定位为 `v0.1.27-pre.1` 预发布；应用内部版本为 `0.1.27`。它不替代此前人工验收的 0.1.26 稳定交付，也不表示干净 Windows 安装验证已经完成。

## 公开入口与归属

- 仓库：[flydommm/bank-receipt-workbench](https://github.com/flydommm/bank-receipt-workbench)。
- 预发布：[v0.1.27-pre.1](https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1)，已公开；GitHub API 核验 `draft=false`、`prerelease=true`。
- 许可：[AGPL-3.0-only](../LICENSE)，第三方组件保留各自许可。
- 普通问题：[Issues](https://github.com/flydommm/bank-receipt-workbench/issues)。
- 安全问题：[私密漏洞报告](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new)，已通过 GitHub API 确认启用。

公开仓库来自经整理的独立源码快照，没有推送原私有开发历史。原项目、业务样本和 0.1.26 稳定安装包保留。

## 对应源码和下载资产

两个安装包、发布标签与源码 ZIP 均固定到 [`ed550857817657f99f82a5268ef6ce81c1dfd7be`](https://github.com/flydommm/bank-receipt-workbench/tree/ed550857817657f99f82a5268ef6ce81c1dfd7be)。后续公开说明和交付记录提交只更新文档，不改变这批二进制。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `bank-receipt-workbench_0.1.27_core_x64-setup.exe` | 30,180,978 | `DF115286006A5EBA7EA3FB21625169595FD469F0368FB39A43EBD8311C29DD02` |
| `bank-receipt-workbench_0.1.27_ocr_x64-setup.exe` | 163,929,509 | `3A5694F365E28A18DA7352F71AFA1A5CAA8DBC49C846C2B48C0054273C02B35D` |
| `bank-receipt-workbench_0.1.27_source.zip` | 1,097,942 | `4FD181A70BE37C014A8EEA3095ABACAB507ED161E61D1D027411C12FD0017C74` |

此外提供 Core/Ocr 各自的 `metadata.zip`、`LICENSE`、`source-info.json` 和 `SHA256SUMS.txt`，共 8 个附件。两个 metadata ZIP 分别保存构建记录、运行时清单和原始许可材料，不用最后构建的 OCR 运行时清单代替 Core 清单。

公开附件使用英文文件名以适配 GitHub 命名；构建记录中的中文安装包名是同一文件的原名，字节和 SHA-256 一致。当前下载应以本页和 Release 附带的 `SHA256SUMS.txt` 核验；[早期准备包记录](delivery-0.1.27-preparation.md)保留为历史资料，其旧哈希不适用于本次公开包。

## 验证证据

- 本地 NSIS 构建、Core/Ocr 私有运行时探针及对应源码归档见 [AGPL 交付记录](delivery-0.1.27-agpl.md)。
- 首次远程 Windows CI：[运行 34526176098](https://github.com/flydommm/bank-receipt-workbench/actions/runs/34526176098)，测试提交 `b6054493b9239018cd94bbce1be132395aae4c24`，最终结果 `success`，Windows 作业耗时 13 分 56 秒。该提交与安装包源码相比仅更新交付文档。
- 远程前端构建与 **55 个测试文件、1,063 项测试通过**；Python **813 项通过、18 项跳过**；Core 运行时准备通过；Rust **73 项单元测试、13 项进程集成测试通过**。本机此前的 Python 811 项记录不含后来独立验证的 2 项许可收集测试，本次远程统一执行并计入。
- 发布后 API 核验标签直接指向 `ed550857817657f99f82a5268ef6ce81c1dfd7be`，没有把后续文档提交误标成安装包构建输入。
- 8 个附件的文件名、大小和 SHA-256 与 GitHub 服务器资产摘要逐项核对一致；校验清单包含其余 7 个附件。
- 原始元数据及源码归档扫描未发现配置敏感词、开发机个人路径或高置信凭据；源码 ZIP 不含 `.git`、真实 PDF、数据库、模型缓存、字节码或构建目录。扫描结果不保证发现所有问题。
- 第三方清单记录 264 个组件、471 份许可文本，许可收集缺失项为零；材料核对不等于独立法律审查。

## 未验证范围

干净 Windows 的安装、升级、卸载、首次 OCR 模型下载及首次识别仍未完成。OCR 本机探针使用已有模型缓存；CI 只测试源码及进程，不运行安装向导。两个安装包未签名，也没有在本次公开交付中重新跑全部真实银行资料回归。

后续正式稳定发布需按[发布清单](release-checklist.md)补齐对应证据。本次保留预发布标记，不将未执行项目勾选为通过。

CI 另有非阻塞提示：`actions/checkout@v4` 和 `actions/setup-python@v5` 的 Node 20 声明由 GitHub 以 Node 24 执行。本次检查通过，后续维护工作流时应升级这些 action 并复验。
