# 贡献指南

感谢你关注银行回单工作台。公开源码版本为 `0.1.27`，安装包按 `v0.1.27-pre.1` 预发布交付；实际下载和公开状态以 [GitHub Releases](https://github.com/flydommm/bank-receipt-workbench/releases) 为准。项目采用 [AGPL-3.0-only](LICENSE)，源码已推送到公开仓库。本文约定可复现、可审阅的本地协作方式；外部贡献须经过维护者审阅后合并。

公开入口：[源码](https://github.com/flydommm/bank-receipt-workbench/tree/main) · [Issues](https://github.com/flydommm/bank-receipt-workbench/issues) · [Releases](https://github.com/flydommm/bank-receipt-workbench/releases) · [GitHub 私密漏洞报告](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new)。

## 开始前

请使用 Windows 10/11 x64，并准备 Git、Bun 1.3+、Rust/Cargo、Python 3.12 和 PowerShell。先阅读：

- [使用指南](docs/usage.md)：了解用户看到的行为和限制；
- [开发指南](docs/development.md)：安装依赖、运行测试和构建 NSIS；
- [第三方组件说明](THIRD_PARTY_NOTICES.md)：了解依赖来源和发布注意事项；
- [安全说明](SECURITY.md)：了解漏洞报告和敏感数据边界。

初始化依赖：

```powershell
bun install --frozen-lockfile
python -m pip install --requirement engine/requirements-dev.txt
```

## 提交前验证

至少运行与改动相关的检查；涉及前端和宿主联动时运行完整公开 CI 对应命令：

```powershell
bun run build
bun run test:web
python -m pytest tests
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

测试应只使用合成数据、公开夹具或临时生成文件。不要为了测试启动真实 OCR、处理真实业务 PDF，或把本机生成的任务数据库、缓存、安装包复制进仓库。

## 变更边界

- 保持原始 PDF 只读，输出写到新文件；
- 不在日志、错误信息、反馈文本或测试快照中写入账号、客户名称、真实文件路径、业务正文、令牌或环境变量值；
- 不把 `outputs/`、`.artifacts/`、`.build/`、`dist/`、`target/`、`.venv/`、模型缓存或安装包加入提交；
- 不新增会自动上传 PDF、OCR 文字、日志或反馈的服务；
- 不擅自改变任务数据库、搜索结果协议、OCR 配方或安装身份；这些变更要说明迁移和兼容影响；
- 不修改、复制或重新许可第三方依赖的许可证文本。项目许可证路线为 AGPL-3.0-only；贡献者不要自行替换根目录 `LICENSE`、把第三方依赖误标为项目许可证，或将项目文本改成其他许可证。

涉及结果算法或 OCR 运行时的修改，应补充有意义的合成测试，并说明是否改变了计算版本、缓存复用或安装包资源。涉及文档的修改应检查是否仍指向公开可访问的相对路径，不要链接本机 `outputs/` 或 `target/`。

## Pull Request 内容

请在描述中写清楚：

1. 变更解决了什么用户问题；
2. 影响了哪些层（前端、Tauri、Python、运行时或文档）；
3. 运行了哪些命令，以及哪些验证尚未做；
4. 是否新增依赖、数据迁移、隐私边界或发布阻塞项。

截图和示例请使用合成内容。若问题只在真实材料上出现，提交前把材料缩减为可公开的合成复现；无法脱敏时，只描述现象和必要的结构，不上传原文件。

## 安全问题

不要通过公共 Issue 或 Pull Request 发布可利用的漏洞细节。请先阅读 [SECURITY.md](SECURITY.md)，并使用 [GitHub 私密漏洞报告](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new) 提交安全问题；普通问题和非敏感建议再使用公开 Issues。
