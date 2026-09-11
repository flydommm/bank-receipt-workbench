# Code signing policy（申请准备稿）

更新日期：2026-09-12。本文描述当前状态与拟采用的签名流程，不表示 SignPath Foundation 已接受申请或提供证书。

## 当前状态

项目为[银行回单工作台](https://github.com/flydommm/bank-receipt-workbench)，采用 [AGPL-3.0-only](../LICENSE)。当前公开安装包为 [v0.1.27-pre.1](https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1)，Core 与 OCR 两种包均未签名。

目前没有提交 SignPath 申请、配置 SignPath 凭据或启用签名工作流。源码测试通过、SHA-256 校验值和开源许可证都不能替代 Windows Authenticode 签名。现有包仍按[公开交付记录](public-release-0.1.27.md)核验；本文不改变其发布状态。

## 拟定职责与签名范围

申请中拟由维护者 [flydommm](https://github.com/flydommm) 承担源码维护、代码审查与发布签名批准职责。这是角色提案，尚不是 SignPath 中已配置的账号或权限；正式接入前需由维护者确认、核实多因素认证，并由 SignPath 确认单维护者安排适用。

拟签文件是从本仓库公开源码构建的主程序、NSIS 卸载程序和 Core/OCR 安装包。不会用项目签名为上游 Python、PDF/OCR 库或微软运行时冒充发行者；这些文件保留上游来源、许可和已有签名。是否允许随包分发相关运行库，按基金会的书面答复确定。

OCR 版中的 OpenCV/Intel IPP 及 Paddle 原生 DLL 已发现需澄清的许可边界，不能把上游主许可证当成所有嵌入组件均开源的证明。详见[依赖专项核查](signpath-assessment-2026-09-12.md#依赖专项核查不能只看包的主许可证)；本稿不承诺 Core/OCR 都会获得基金会签名。

不会将用户 PDF、OCR 业务文字、任务数据库、私有日志或模型缓存提交给签名服务。拟提交给签名服务的是公开源码对应的软件二进制和构建来源资料。

## 拟采用的发布控制

以下控制尚未实施；实际接入与验证完成后才改为生效政策：

- 将现有发布脚本接入 GitHub 托管的 Windows 构建任务，以固定公开提交构建并保留工作流运行与产物关联；不能仅上传本机生成的 EXE 来声称托管构建。
- 只允许经过维护者审查的发布输入请求签名；普通 PR、外部贡献分支不获得签名凭据。
- 每次正式签名由维护者人工批准。凭据限定签名请求所需权限，使用受保护的存储，不进入仓库或日志。
- 明确签名文件白名单、产品名和版本，并核查 NSIS 内部主程序及卸载程序；仅外层 EXE 有签名不足以声称全部已签。
- 验证最终文件的签名链、发行者和时间戳，再生成哈希、edition 清单及发布记录。签名失败时停止签名版交付。
- 在新发布记录中说明签名范围与验证边界，保留旧版资产及其哈希，不默默替换现有未签名附件。

NSIS 的外部签名流程尚待实证，不能直接把 MSI 的内部文件签名示例套用到 NSIS。参考 [NSIS 卸载程序外部签名说明](https://nsis.sourceforge.io/Signing_an_Uninstaller_externally)与 [SignPath GitHub 构建来源验证](https://docs.signpath.io/trusted-build-systems/github)。

## 数据处理与网络边界

项目的 PDF 解析、搜索、OCR 推理、候选框审核及导出在本机执行。原件只读；OCR 文字缓存、任务记录和输出保存在用户控制的设备或目录中。应用没有云端 PDF 处理、后台反馈上传或自动更新服务。

网络边界不能笼统写成“完全不联网”：

- OCR 初始化可能通过上游运行库请求公开模型文件或检查下载来源。请求会向模型分发服务暴露通常的网络连接信息；应用不将 PDF 内容作为模型下载请求上传。首次下载的实际端点、模型许可和第三方行为仍待独立验证，见[发布清单](release-checklist.md)。
- 安装器在需要时可能下载 Microsoft WebView2。微软运行时有独立的更新和数据处理行为，不能由本项目承诺其完全离线。
- 帮助页面展示的 GitHub 等外部网址，在用户自行访问时适用对应网站的规则。反馈功能仅生成本地文本，是否分享由用户决定。

更多现有说明见 [README 的本地处理与文件保护](../README.md#本地处理与文件保护)、[安全说明](../SECURITY.md)和[第三方组件说明](../THIRD_PARTY_NOTICES.md)。正式申请前应核实受影响第三方的隐私说明与实际下载行为，不能把这份准备稿当成已经完成网络审计。

## 获批后的更新

只有基金会确认接受并实际启用对应签名后，才加入其要求的赞助说明及链接，并更新本页、README 和后续下载页的真实签名状态。现在不使用“已由 SignPath 签名”标识。

资格评估与待确认问题见[申请准备记录](signpath-assessment-2026-09-12.md)；申请内容见[英文申请草稿](signpath-application-draft.md)。官方条件：[SignPath Foundation terms](https://signpath.org/terms)。
