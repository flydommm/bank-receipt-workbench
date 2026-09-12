# 贡献指南

感谢你关注银行回单工作台。项目采用 [AGPL-3.0-only](LICENSE)。本指南约定如何提交可审阅、可复现的贡献，也说明贡献者、第三方材料和 DCO 的边界。它不是独立法律意见，也不保证不存在权利争议或其他纠纷。

贡献者保留自己贡献的版权。项目只接收贡献者有权许可的原创贡献，并按 AGPL-3.0-only 接收和分发这些原创贡献。本项目不要求版权转让或 CLA，也不会因为一次贡献自动取得专有再许可权。第三方内容继续适用其原许可证和通知；项目不会把第三方内容宣称为重新许可后的项目内容。

## 开始前

请先阅读：

- [README](README.md)：了解应用范围、预发布状态和数据边界；
- [开发指南](docs/development.md)：安装依赖、运行测试和构建 Windows 安装包；
- [第三方组件说明](THIRD_PARTY_NOTICES.md)：核对依赖来源、版本和原许可证通知；
- [安全说明](SECURITY.md)：了解漏洞报告和敏感数据边界。

开发环境面向 Windows 10/11 x64，需要 Git、Bun 1.3+、Rust/Cargo、Python 3.12 和 PowerShell。初始化依赖：

```powershell
bun install --frozen-lockfile
python -m pip install --requirement engine/requirements-dev.txt
```

## 许可证和来源边界

### 原创贡献

- 你保留原创贡献的版权，并确认自己有权把它按 AGPL-3.0-only 提供给本项目；
- 雇佣、委托或其他合同可能影响权利归属。提交前请取得雇主或合同相对方要求的授权，不要把没有授权的工作作为个人原创贡献提交；
- 项目不要求版权转让、CLA 或额外的商业再许可授权。若未来需要改变许可证安排，应另行公开说明并取得相应授权，不从当前贡献中推定专有再许可权；
- GitHub 关于仓库许可证下贡献的条款可参阅 [Contributions under repository license](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)。

### 第三方材料

第三方代码、依赖、图片、字体、文档和测试夹具都要按来源审查。Pull Request 中请列出每项材料的来源链接、版本或提交、原许可证、受影响文件或目录，以及许可证文本和版权通知的保留位置；发布内容还要同步检查 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

第三方许可证和通知必须按原样保留并满足兼容性要求。不要把第三方材料改标为 AGPL-3.0-only、MIT 或其他项目许可证，也不要自行替换、删除或重新许可其许可证文本。来源、版本或许可不清楚时，先暂停合并并请求维护者核实。现有外部来源仍需审查，不能因为它已经在旧历史中就跳过核对。

如果使用 AI 辅助，请由贡献者自己检查来源、许可证、事实和代码正确性。AI 不是签署人，也不能替贡献者证明版权或保证不存在侵权；DCO 必须由实际贡献者完成。业务银行材料、真实账号、客户信息、真实 PDF、识别文字、私有日志和本机缓存不得进入仓库、Issue、Pull Request 或测试夹具。测试请使用合成数据、公开夹具或临时生成文件。

## DCO 1.1 和 Signed-off-by

DCO 1.1 全文保存在仓库根目录的 [DCO](DCO)；也可以查看 [Developer Certificate of Origin](https://developercertificate.org/)。每个 Pull Request 最多包含 250 个提交；超过这个数量请先拆分 Pull Request。每个 Pull Request 的每个 Git 提交都必须满足下面的记录检查：

- Git 提交的 author 姓名与邮箱组合必须有一个匹配的 `Signed-off-by: Name <email>` 末尾 trailer；
- 提交中的每个 `Co-authored-by: Name <email>` 共同作者也必须各有匹配的 `Signed-off-by` trailer；
- `Co-authored-by` 和 `Signed-off-by` 必须放在提交消息结尾的独立、连续 trailer 段中；这段之后不要再写正文，正文里的同名文本不计入签署；
- 姓名按 Git 身份匹配，允许 Unicode 字符和正常空白，不要求 ASCII 化；邮箱比较不区分大小写；
- GitHub 隐私 `noreply` 邮箱可以使用，但必须与该提交中记录的 Git 作者身份一致；
- 不能因为提交者是维护者、机器人或合并提交就自动豁免。PR 中的所有提交都要检查。

`Signed-off-by` 是对来源和许可权的声明，不是 Windows 代码签名，也不是版权转让。签署信息会随 Git 历史永久公开；不要填写身份证号、住址或其他不必要的个人信息。自动检查只能核对提交记录，不能证明签署人的真实身份、雇主授权或其确实拥有相关权利。

最简单的单作者提交方式是：

```powershell
git commit -s -m "Describe the change"
```

`-s` 只会为当前提交身份添加 trailer。共同作者的 `Co-authored-by` 和对应 `Signed-off-by` 需要在提交消息结尾的独立、连续 trailer 段中完整保留并逐一核对。只有在你自己有权证明该提交内容且只修改自己的提交时，才使用：

```powershell
git commit --amend --no-edit -s
```

公共分支重写历史前要与协作者沟通；确需更新时使用 `--force-with-lease`。不要随意批量替别人补签，也不要盲目 rebase。旧 `main` 历史不追溯批量改写；这不免除对其中现有外部来源的来源和许可证审查。

## 提交前验证

至少运行与改动相关的检查；前端和宿主联动的改动应运行当前公开 CI 对应命令：

```powershell
bun run build
bun run test:web
python -m pytest tests
$env:PDF_SEARCH_TEST_PYTHON = (Get-Command python).Source
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

在 Pull Request 中写明实际运行的命令、结果和未运行的检查。涉及结果算法、OCR 运行时、协议、资源清单或数据清理时，说明行为和兼容性影响，并补充有意义的合成测试。不要把“当前开发机能启动”写成“已在干净 Windows 上安装通过”。

## Pull Request 内容

请使用 [Pull Request 模板](.github/pull_request_template.md)，并在描述中说明：

1. 变更解决了什么用户问题；
2. 影响了哪些层（前端、Tauri、Python、运行时或文档）；
3. 运行了哪些命令，以及哪些验证尚未做；
4. 第三方材料明细；没有新增时明确写“无”；
5. DCO 记录、原创贡献按 AGPL-3.0-only 提供的确认、雇主授权情况和任何发布阻塞项；
6. 是否可能包含敏感信息，以及你如何使用合成或脱敏复现替代它。

模板中的勾选和文字是贡献者提供的记录与声明，不等于维护者已经完成法律审查，也不构成“没有纠纷”的保证。

## CI、审查和合并规则

仓库提供 [DCO 工作流](.github/workflows/dco.yml)，读取可信主分支中的检查程序，不执行 PR 中的代码。它检查全部 PR 提交的作者、共同作者和签署记录，并把结果写入当前 PR 提交的 `DCO` 状态。超过 250 个提交、分页不完整、API 失败或检查期间 PR 发生变化时，不会报告通过；维护者、机器人和合并提交都没有自动豁免。检查程序可用 `node --test scripts/check-dco.test.cjs` 在本地验证。

现有 `.github/workflows/ci.yml` 的 `Windows verification` 必须通过。建议由维护者核查 `main` 的 GitHub 规则：要求 Pull Request 合并、将 `DCO` 和 `Windows verification` 设为必需检查、禁止强制推送和删除分支；如果只有一名维护者，不要因为自己的 PR 强制额外一名审批而把仓库锁死。外部 PR 仍必须由 `flydommm` 实际审查。来源不清时拒绝合并，不盲目代签或重新许可。

实际启用状态和第一份外部 PR 合并前的操作见[贡献审查清单](docs/contribution-review.md)。仓库中有工作流不等于远端已设置必需检查；远端验收完成前，不合并外部 PR。

合并前保留 Pull Request 讨论、审查结论、验证结果和已核验的 head SHA。使用 squash 或 rebase 时，维护者必须确认所有原始贡献者的 `Co-authored-by` 与 `Signed-off-by` 声明仍然保留；不要用改写历史掩盖来源。使用 merge commit 可以保留带 `Signed-off-by` 的原始提交，具体合并方式由维护者根据当前 GitHub 设置选择。

## 安全问题

不要通过公共 Issue 或 Pull Request 发布可利用的漏洞细节。请先阅读 [SECURITY.md](SECURITY.md)，并使用 [GitHub 私密漏洞报告](https://github.com/flydommm/bank-receipt-workbench/security/advisories/new) 提交安全问题；普通问题和非敏感建议再使用公开 Issues。
