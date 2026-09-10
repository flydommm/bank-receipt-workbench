# 第三方组件与发布许可

本文件说明依赖来源，不替代各组件的许可证，也不授予第三方依赖以外的项目许可。项目许可路线已确定为 **AGPL-3.0-only**，当前准备目录已包含对应的根目录 `LICENSE`；公开发布前仍需核对对应源码和安装包的分发义务。当前目录为发布准备版本。

公开源码入口为 [https://github.com/flydommm/bank-receipt-workbench/tree/main](https://github.com/flydommm/bank-receipt-workbench/tree/main)。仓库已经创建，但源码尚未推送到 `main`，Release 尚未发布；该地址当前不代表已有公开源码。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| PyMuPDF / MuPDF | PDF 解析、渲染、裁剪和导出 | 按上游 AGPL 分发路线处理，见 [官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)；运行时保留 wheel 内的 COPYING 等文本 |
| CPython | 应用私有 Python 解释器 | PSF 及其随附第三方声明，见运行时 `LICENSE.txt` 和 [Python 许可](https://docs.python.org/3/license.html) |
| python-build-standalone | 可移植 Python 发行包来源 | [Astral 项目](https://github.com/astral-sh/python-build-standalone)；发行包固定地址与 SHA-256 记录于 `scripts/runtime-manifest.json`，运行时内许可证随包保留 |
| PaddleOCR / PaddlePaddle / PaddleX | 可选本地 CPU OCR | 各上游项目的 Apache-2.0 许可及随附第三方声明：[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)、[PaddlePaddle](https://github.com/PaddlePaddle/Paddle/blob/develop/LICENSE)、[PaddleX](https://github.com/PaddlePaddle/PaddleX/blob/develop/LICENSE) |
| React / React DOM | 前端界面 | MIT，随依赖分发的 LICENSE |
| Tauri | 桌面框架 | MIT / Apache-2.0，见 [Tauri 仓库](https://github.com/tauri-apps/tauri) |
| NSIS 安装器模板 | Windows 安装界面与升级 | 项目中保留 `src-tauri/nsis/LICENSE-MIT`；这份许可证仅属于模板 |

上述列表是主要组件摘要。每个安装包同时交付 `runtime-info.json`，包含实际 Python 包名称、版本、许可证元数据及许可证文件位置；各包的原始许可证保留在运行时目录中。元数据可能不完整，发布前仍需检查原始 LICENSE/NOTICE。前端及 Rust 的精确依赖由 `bun.lock`、`Cargo.lock` 记录。

发布脚本还将原始前端和 Rust 许可文本汇总到安装目录的 `runtime/THIRD_PARTY_LICENSES.txt`，并附 `runtime/third-party-inventory.json`，记录版本、来源、原始文本与校验值。Rust 清单保守包含 Windows 目标解析到的构建依赖，不宣称是精确的二进制组成清单。缺少许可文本时发布构建会停止；少数上游 crate 未附带根目录许可证的情况，使用 `third-party/licenses/` 中按上游提交与版本固定的原始文本补充。

OCR 安装包包含识别库，**不包含模型权重**。首次使用由上游运行库下载公开模型；下载来源、模型许可和缓存行为应在新增或更换模型时另行核实。原始 PDF、识别出的业务文字及用户缓存均不属于软件发布内容。

项目采用 AGPL-3.0-only 路线，PyMuPDF/MuPDF 按上游 AGPL 分发路线处理；公开版本仍需随包提供或明确指向相应源码、构建说明和许可文本。项目许可证不改变其他第三方依赖的许可条件，不得宣称所有代码与依赖均可按 MIT 分发。
