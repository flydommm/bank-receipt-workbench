# SignPath Foundation 申请资料草稿

准备日期：2026-09-12。**未提交；未注册账号；未接受条款；未获批。** 本文可以公开，不包含申请人姓名、邮箱或任何凭据。先阅读[评估结论](signpath-assessment-2026-09-12.md)。

## 申请入口及使用方式

官方入口：[Apply for a free SignPath.io subscription](https://signpath.org/apply)。本次已在浏览器读取其 HubSpot 嵌入表单，核对下列字段；没有向表单填写或发送信息。字段今后可能改变，提交时重新核对。

以下英文材料可逐项复制。建议先用末尾的资格询问稿确认依赖与新项目条件，再提交完整申请。不能为通过表单而把计划中的签名、托管构建或使用规模写成已完成。

## 已准备的项目字段

| 表单字段 | 建议内容或处理方式 |
| --- | --- |
| Project Name（必填） | Bank Receipt Workbench (银行回单工作台) — flydommm/bank-receipt-workbench |
| Repository URL（必填） | https://github.com/flydommm/bank-receipt-workbench |
| Homepage URL（必填） | https://github.com/flydommm/bank-receipt-workbench |
| Download URL | https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1 |
| Privacy Policy URL | 可先提供现有公开安全说明：https://github.com/flydommm/bank-receipt-workbench/blob/main/SECURITY.md 。它不是完整第三方网络审计；正式提交前应与本地政策稿及基金会要求对齐。 |
| Wikipedia URL（可选） | 留空；没有核实到本项目的英文维基条目。 |
| Maintainer Type | 拟按个人维护项目填写；下拉选项的具体值与申请人身份待提交时核实。 |
| Build System | 当前 GitHub Actions 只运行源码测试，发布包在本机用脚本构建。签名用托管发布流水线尚未接入；不要仅选择 GitHub Actions 而省略此限制。 |
| Company Name | 无公司身份已确认；不从银行 PDF、开发机或历史记录推断单位。 |
| Primary Discovery Channel（必填） | 按实际下拉选项选择与 AI assistant / ChatGPT 对应的类别；具体选项值待提交时核实。 |
| Please specify the exact source（可选） | Recommended during a Codex-assisted review of Microsoft Windows code-signing documentation; subsequently checked against the SignPath Foundation website. |

表单的 Download URL 提示下载页应提到使用 SignPath。我们目前尚未使用该服务，不能提前宣称已获赞助。先询问基金会是否接受“申请准备中、现有包未签名”的政策说明；本地 [Code signing policy](code-signing-policy.md) 尚未推送，不得把未公开的文档 URL 当成已可访问的证据。

### Tagline（必填）

```text
A Windows desktop workbench for locally searching, reviewing, splitting and exporting bank receipt PDFs, with optional on-device OCR.
```

### Description（必填）

```text
Bank Receipt Workbench helps users find relevant transactions in bank receipt PDFs, inspect the original pages, review and adjust receipt boundaries, and export selected receipts with an optional spreadsheet index. It handles text-based documents and supports scanned documents through optional on-device OCR. Users retain control of the original files and review the proposed results before export. PDF processing takes place on the user's computer. The project does not upload PDF contents to a cloud processing service; initial OCR setup may download public model files.
```

### Reputation（必填）

```text
This is a newly public project maintained under the GitHub account flydommm. The public repository was created on 10 September 2026, following private development and maintainer testing. Its first public prerelease provides Windows Core and OCR installers, corresponding source, checksums and build metadata. We do not yet claim broad adoption, independent endorsements or an established public reputation.

Repository and public history:
https://github.com/flydommm/bank-receipt-workbench

Existing unsigned prerelease:
https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1

Published verification record and its limitations:
https://github.com/flydommm/bank-receipt-workbench/blob/main/docs/public-release-0.1.27.md

Successful source-verification workflow (not an installer build):
https://github.com/flydommm/bank-receipt-workbench/actions/runs/34526176098

We would appreciate guidance on whether this evidence is sufficient at this stage, or what further public track record would be needed before applying for Foundation-sponsored signing.
```

## 正式申请时由维护者填写或确认

| 字段或操作 | 当前状态 |
| --- | --- |
| First Name、Last Name（必填） | 未提供。不从 Git 提交作者信息或其他数据推断。 |
| Email（必填） | 未提供。用来创建 SignPath 账号并接收通知；不应写入公开仓库。 |
| GitHub / SignPath 多因素认证 | 本次没有检查或修改账户安全设置；正式接入前由维护者核实。 |
| 维护、审查和签名批准角色 | 拟由 flydommm 承担，须确认并获得基金会认可，AI 工具不替代有权限的人工批准人。 |
| 基金会行为准则及以基金会名义签名的条款 | 必填同意项；本次未勾选，提交时由维护者审阅并确认。 |
| 个人数据保存和处理 | 必填同意项；本次未勾选。表单由 HubSpot 嵌入，提交会向外部服务发送信息。 |
| 其他通信/营销订阅 | 可选，本次未勾选；不作为申请前提。 |
| reCAPTCHA、Submit | 本次未操作。 |

## 资格询问英文稿（未发送）

建议主题：Eligibility guidance for Bank Receipt Workbench — new AGPL project with NSIS installers

```text
Hello SignPath Foundation team,

I maintain Bank Receipt Workbench (银行回单工作台), an AGPL-3.0-only Windows desktop project:
https://github.com/flydommm/bank-receipt-workbench

The application performs local PDF keyword search, receipt-boundary review, splitting and PDF/XLSX export, with optional local OCR. Our first public prerelease contains unsigned Core and OCR NSIS installers, source and build metadata:
https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1

Before submitting a full application, could you clarify these points?

1. The repository became public on 10 September 2026. We have published source-verification results and release metadata, but no broad public adoption or independent reputation claims. Is an application appropriate now, or should we establish a longer public track record first?

2. The project is distributed under AGPL-3.0-only. It uses PyMuPDF/MuPDF under the upstream AGPL option; upstream also offers commercial licensing. Does using the AGPL option satisfy your policy concerning commercial dual licensing? We are not requesting signing for the upstream libraries themselves.

3. The installers redistribute an upstream Python runtime and PDF libraries; the OCR edition adds PaddleOCR/PaddlePaddle and binary dependencies. Our audit found Intel IPP ICV listed as statically linked in opencv-contrib-python 4.10.0.84 under the Intel Simplified Software License, and found mklml.dll, libiomp5md.dll and mkldnn.dll inside the Paddle 3.3.1 wheel without a complete component-level license mapping. We therefore cannot declare the entire OCR package to consist solely of open-source components. The installer may also download Microsoft's WebView2 runtime and redistributes Microsoft runtime components. Are any exceptions applicable, or would those dependencies need to change? If the OCR edition is ineligible, could the Core edition be considered separately after its own dependencies are reviewed? OCR model files are downloaded on first use and are not bundled; their initial download and license verification remain open items.

4. Our current GitHub-hosted workflow verifies source and tests, while existing NSIS installers were built locally using public build scripts with pinned dependencies. We plan to move release builds into GitHub-hosted workflows. What approved sequence should a Tauri/NSIS project use to sign its own application executable, generated uninstaller and final installers with verified build origin? We would preserve upstream signatures and not sign third-party binaries under the project certificate.

5. Is a single maintainer acting as author, reviewer and release-signing approver acceptable? Account MFA and service permissions will be verified before enabling signing. Your application form asks for a download page mentioning SignPath: while approval is pending, is an explicitly pending policy notice acceptable instead of claiming that existing unsigned releases already use the service?

Our current limitations are disclosed in the public release record, including incomplete clean-Windows install/upgrade/uninstall and first-model-download validation. We are seeking eligibility guidance, not claiming that the current release is signed or already meets all signing prerequisites.

Thank you,
flydommm
```

该稿只包含公开项目资料和上游组件核查事实，已纳入本次依赖发现；没有发送给基金会。正式发送前由维护者确认收件渠道、联系身份和最终文本。申请入口未见专用“备注”字段，不把上述技术问题挤入产品 Description；可通过基金会认可的联系渠道先行询问。
