# 0.1.27 本地交付记录（公开发布准备）

日期：2026-09-11。状态：本地构建与校验完成；未向 GitHub 推送、未发布 Release、未标记为新的稳定版。

两个安装包均从干净提交 `a5ef9c0e941238dd1a5ffb98f9aa4e865900a80c` 构建，目标为 Windows x64。后续增加本交付记录的文档提交不改变已经生成的安装包。

## 安装包与校验值

| 安装包 | 内容 | 字节数 | 大小 |
| --- | --- | ---: | ---: |
| `银行回单工作台_0.1.27_core_x64-setup.exe` | 文字型 PDF；私有 Python 和 PyMuPDF | 30,163,740 | 28.8 MiB |
| `银行回单工作台_0.1.27_ocr_x64-setup.exe` | 文字型与扫描 PDF；另含本地 OCR 识别库 | 163,931,612 | 156.3 MiB |

Core SHA-256：

```text
95249F297FA7B4662C24CACC0AE53661A553787595A7D84B87EBE05443F3668B
```

OCR SHA-256：

```text
F520A6F1E8CDF7B5671974D24E9D16D7F075A2AA5FCC75E7A7B8ABB6C883063D
```

两个包共用应用标识，选择其中一个安装。OCR 包包含识别库，不包含模型权重；首次使用可能下载模型。两个安装包均未签名，尚未在干净 Windows 上安装验收。

## 构建证据

- Bun：1.3.14；Rust：1.97.1；私有 Python：3.12.14。
- 实际使用 Windows PowerShell 5.1 运行 `scripts/build-release.ps1 -Edition Core` 和 `-Edition Ocr`。
- 构建前后源码提交一致，工作树干净，安装包生成时间属于本次构建。
- 已按实际文件重新核对安装包大小、SHA-256、运行时清单哈希和第三方清单哈希。
- 每个包的本地交付目录附带 `build-info.json`、`runtime-info.json`、`third-party-inventory.json` 和 `THIRD_PARTY_LICENSES.txt`；这些记录与其对应安装包共同保存。
- 第三方前端/Rust 清单包含 264 个组件、471 份原始许可与通知文本；公开清单不含构建机个人绝对路径。Python 依赖原始许可保留在安装目录的运行时中。
- 待公开源码树扫描通过；检查了新仓库可达提交和源文件对象，未发现配置规则或本地敏感词表的命中。原开发历史没有导入新仓库。

本地安装包、运行时、日志和构建缓存受 `.gitignore` 保护。公开发布时，安装包应作为 Release 资产上传，不加入 Git 源码历史；此文档不提供尚不存在的公开下载地址。

## 验证与未完成事项

本轮前端、Python、Rust 以及 Core/OCR 运行时验证范围见[公开发布准备记录](preparation-status.md)。实际 OCR 探针使用已有模型缓存；没有把它当成首次模型下载验证或完整业务样本验收。

公开前仍需确定 GitHub 仓库归属、项目许可证及 PyMuPDF 许可路径，完成独立 Windows 的安装/升级/卸载和首次 OCR 验证，并执行第一次远程 CI。具体门槛见[发布清单](release-checklist.md)。原项目的 0.1.26 稳定版保留。
