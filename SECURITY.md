# 安全说明

银行回单工作台面向本机处理敏感 PDF。公开源码版本为 `0.1.27`，安装包按 `v0.1.27-pre.1` 预发布交付；实际下载和公开状态以 [GitHub Releases](https://github.com/flydommm/bank-receipt-workbench/releases) 为准。项目采用 [AGPL-3.0-only](LICENSE)，源码已推送到公开仓库。

公开入口：[源码](https://github.com/flydommm/bank-receipt-workbench/tree/main) · [Issues](https://github.com/flydommm/bank-receipt-workbench/issues) · [Releases](https://github.com/flydommm/bank-receipt-workbench/releases) · [GitHub 私密漏洞报告](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new)（需登录 GitHub）。

## 处理边界

- PDF、OCR 文字、命中坐标、任务数据库、临时预览和导出结果应留在用户控制的设备或目录中。
- 应用不提供云端 PDF 处理、自动反馈上传、反馈服务器或自动更新服务。OCR 首次初始化可能联网下载公开模型；用户主动使用反馈入口时，应用还可能打开外部邮件客户端或 GitHub 网页，实际发送和提交由用户完成。
- “帮助与反馈”的“03 使用反馈”先生成本地预览，支持本地复制或保存 TXT；邮件和 GitHub 入口会先复制预览再打开外部目标，微信入口只展示或复制 `vinz2009`。应用不会自动创建 Issue、发送消息或附加 PDF、日志；用户自行填写的内容可能包含敏感信息，分享前必须检查。应用不会将预览正文写入外部链接的 URL 参数。
- 测试和 CI 只使用合成数据；不要把真实 PDF、账号、客户名称、绝对路径、日志、模型缓存或任务数据库提交到 Git。

## 如何报告疑似漏洞

不要在公共 Issue、Pull Request、聊天记录或公开日志中描述可直接利用的细节，也不要附上真实业务文件。普通问题和非敏感建议请使用 [Issues](https://github.com/flydommm/bank-receipt-workbench/issues) 或[使用指南中的邮件、微信渠道](docs/usage.md#如何反馈问题)；安全问题请使用已启用的 [GitHub 私密漏洞报告入口](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new)。

请保留最小的合成复现，并在私密报告中避免附上真实业务文件。若问题涉及已暴露的令牌、密码或私钥，应立即在对应系统撤销或轮换，然后只提供不含秘密的时间线和影响范围。

## 报告内容

通过私密报告入口提交时，报告应尽量包含：

- 受影响的版本、edition 和 Windows 版本；
- 最小合成复现步骤和预期/实际行为；
- 影响的边界（例如本地任意文件读取、路径越界、导出覆盖、进程权限或信息泄露）；
- 已知的缓解方式；
- 不含业务正文、账号、绝对路径和秘密的日志片段。

不要为了证明问题而删除原始 PDF、修改用户任务数据库或访问不属于自己的目录。对于文件删除、覆盖和外部服务写入类问题，先停止复现并保留现场。

## 依赖和发布前安全门槛

正式稳定发布前，仍需完成干净 Windows 安装、升级、卸载和首次模型下载验证。当前已提供应用对应源码归档、构建说明、第三方版本及来源与许可清单，源码和附件也已完成配置规则下的隐私扫描；技术核对不替代独立法律审查，也不保证发现所有敏感信息。当前预发布安装包未签名；CI 只验证代码，不自动发布安装包，也不上传私有样本。
