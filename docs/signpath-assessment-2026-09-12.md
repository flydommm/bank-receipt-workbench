# SignPath Foundation 申请准备评估

日期：2026-09-12。结论：**值得先做资格询问，尚不能声称全部条件已满足；OCR 版包含不能直接认定为开源的二进制组件，存在实质资格障碍。** 本轮完成资料准备，不提交申请、不购买证书、不启用签名、不更改现有安装包。

## 检查基线

- 公开仓库：[flydommm/bank-receipt-workbench](https://github.com/flydommm/bank-receipt-workbench)，仓库 API 确认 public，创建时间 `2026-09-10T19:59:03Z`。
- 检查时本地及远端 `main` 均为 `848ec2463dd28618bba8382e05c42005764dac8d`。此次准备文件是其后的文档变更，不是重构建。
- 当前发布：[v0.1.27-pre.1](https://github.com/flydommm/bank-receipt-workbench/releases/tag/v0.1.27-pre.1)，API 确认 `draft=false`、`prerelease=true`，8 个维护者上传附件。页面额外生成的源码下载入口不计入这 8 项。
- 现有安装包对应提交 `ed550857817657f99f82a5268ef6ce81c1dfd7be`；两种 EXE、源码和校验值见[公开交付记录](public-release-0.1.27.md)。没有移动标签或替换资产。
- GitHub API 当时记录 1 star、0 fork，仅作时点事实，不构成成熟度指标。没有找到可核验的广泛采用或第三方背书资料，申请中不编造用户数或宣传数据。

## 条件与差距

| 项目 | 现有证据 | 评估及下一步 |
| --- | --- | --- |
| 公开源码、维护与发行 | 仓库可访问，README/使用指南齐备，已有 NSIS 预发布 | 有申请基础；预发布不等于经过干净系统验收的稳定版。 |
| 项目自身许可证 | `LICENSE`、`package.json`、`src-tauri/Cargo.toml` 为 AGPL-3.0-only | 已明确选择开源分发路线；不等于所有依赖自动符合基金会政策。 |
| 依赖的计划资格 | PyMuPDF 1.28.2 的元数据声明 AGPL / Artifex 商业双许可；本项目选用 AGPL | 基金会条件提及商业双许可限制，应书面询问其对上游双许可依赖的解释；不能自行判定符合或违规。 |
| OCR 原生组件的许可 | OpenCV 的附带通知列明 Intel IPP 二进制许可；Paddle wheel 内含 `mklml.dll` 等，尚未对应到完整许可链 | 不能填写“全部组件均为开源”。需基金会明确接受相应范围/例外，或另行设计许可链清楚的构建；详情见下节。 |
| 微软及其他上游运行时 | NSIS 可引导 WebView2 安装；私有 Python 与 OCR 带原生依赖 | 列明分发范围，询问 System Libraries 例外及第三方组件要求；保留上游签名，不用项目证书代签。 |
| 构建来源 | 发布脚本锁定 Python 下载与 wheel 哈希，记录干净源码提交；现有包为本机构建 | 可追溯，但不是 SignPath 已验证的托管产物。`.github/workflows/ci.yml` 目前仅测试，未生成并上传待签 NSIS。 |
| 项目信誉 | 刚公开；已有源码测试与交付材料 | 申请表 Reputation 为必填。坦诚提交已有证据，并询问是否应积累更多公开记录；官方没有在本次所查条件中公布统一 star 数门槛。 |
| 维护者身份与 MFA | 维护者 GitHub 名称已知 | 姓名、申请邮箱、账号 MFA 和单维护者角色安排均待本人/基金会确认；未检查或修改账号设置。 |
| 签名政策 | 本轮补齐 [Code signing policy](code-signing-policy.md) 准备稿 | 草稿未生效且未推送，不宣称已获 SignPath 赞助。 |
| 隐私与首次下载 | 原件只读、反馈本地生成；OCR 可下载模型；WebView2 可联网安装 | 已有用户说明，仍需核实实际模型端点、权重许可及第三方隐私行为，不能承诺所有组件绝不联网。 |
| 安装环境验收 | 现有记录明确未完成干净 Windows 安装/升级/卸载与首次模型下载 | 继续保留预发布状态；这是本项目发布质量待办，不把它夸大为基金会明确规定的所有申请前置条件。 |

上述基金会条件依据 [Foundation terms](https://signpath.org/terms)；其页面自标为 draft，申请时应重读当时生效文本。上游双许可事实见 [PyMuPDF 官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)。本评估区分项目事实与第三方政策待解释项，不对法律合规或获批作保证。

## 依赖专项核查：不能只看包的主许可证

核对对象是公开锁文件、已存在的本地固定依赖 wheel/运行时及交付清单，没有读取业务 PDF。本地 OCR 运行时 `runtime-info.json` 的 SHA-256 与 `outputs/releases/0.1.27-ocr-ed5508578176/runtime-info.json` 相同；结合安装器整个运行时目录的资源映射判断其分发范围。本次没有重新解包并逐文件重验已发布 EXE。

1. **OpenCV / Intel IPP：已发现严格开源条件下的实质障碍。** `opencv_contrib_python-4.10.0.84.dist-info/LICENSE-3RD-PARTY.txt` 第 2990–3009 行说明 Intel IPP ICV 静态链接在 x86/x64 包中，适用 Intel Simplified Software License（October 2022），仅二进制分发并限制修改和逆向操作。这不能被包级 Apache-2.0 元数据覆盖，也不能宣称是全部开源；应先询问基金会是否存在适用例外。若不接受，需另行评估关闭 IPP 的开源构建，不能只删一份许可证或一个 DLL 来掩盖静态链接组件。
2. **Paddle 原生 DLL：许可来源仍缺证据。** 固定 `paddlepaddle-3.3.1-cp312-cp312-win_amd64.whl` 中确认有 `paddle/libs/mklml.dll`、`libiomp5md.dll` 和 `mkldnn.dll`。该 wheel 的主 LICENSE 为 Apache-2.0，检查中未找到分别覆盖这些 DLL 的独立许可/NOTICE。不能仅凭名称断定每个 DLL 的许可，也不能用 Paddle 主许可证代替它们；需补齐确切来源、版本与通知材料。
3. **系统运行库与安装器：需明确基金会允许的边界。** 私有运行时中存在 `vcruntime140.dll` 等微软组件；NSIS 保留 WebView2 下载/安装逻辑。Tauri CLI 模板来源已固定在 `src-tauri/nsis/README.md`，但安装器插件及构建期组件不能仅靠现有 Python 包和前端生产依赖清单代表。
4. **清单能力有限。** `scripts/runtime-inventory.py` 收集包级元数据与许可文件路径；`scripts/collect-third-party-notices.py` 收集前端/Rust 许可，均不是对所有嵌入原生二进制的完整许可判定。历史记录的“缺失文本为零”不能解释为本次基金会资格审核已通过。另有 `third-party/licenses/selectors/source.json` 的 MPL 文本和组件 NOTICE 来自不同上游提交，应补充来源关系说明；来源不同本身不是已经证实的许可错误。

Core 不含上述完整 OCR 依赖，后续可以先讨论 Core 的资格，但仍需确认 PyMuPDF、微软运行时和构建链，不能直接认定 Core 已合格。本轮没有更换任何依赖，也未改动既有许可声明或删除通知文件。

## 拟签内容与 NSIS 接入边界

| 内容 | 拟处理方式 |
| --- | --- |
| 本项目 `pdf-search.exe` | 从公开源码构建后签名，产品显示名保持“银行回单工作台”。 |
| 本项目生成的 NSIS `uninstall.exe` | 在打包阶段完成可核验的签名并嵌入，安装后检查实际文件。 |
| Core 与 OCR 的最终 `*-setup.exe` | 内部目标确定后签最终外层，分别记录哈希和签名结果。 |
| CPython、PyMuPDF、Paddle 等上游 EXE/DLL/PYD | 按各自许可分发，保留和核查已有签名；不默认纳入本项目签名白名单。 |
| PDF、业务缓存、数据库、原始截图、模型缓存 | 不提交给基金会或签名服务，不纳入公开构建产物。 |

本地配置证据：`src-tauri/tauri.conf.json` 尚无 `signCommand` 等签名配置；`src-tauri/nsis/installer.nsi` 第 71、101–104 行保留 `uninstaller_sign_cmd` / `!uninstfinalize` 接口。`scripts/build-release.ps1` 第 83 行只把有效签名状态写入元数据，不执行签名，也不会因未签名而失败。

SignPath 的 [GitHub connector](https://docs.signpath.io/trusted-build-systems/github) 验证工作流产物来源，OSS 签名请求之前的工作应使用 GitHub 托管 runner。把已有本地安装包重新上传成 Actions 附件不满足该目的。

签名设计不能只照抄 MSI 的嵌套签名配置。官方[文件格式参考](https://docs.signpath.io/artifact-configuration/reference)没有明确给出 NSIS 内部文件的同类一步签名方案；需确认先签应用/生成卸载程序、再嵌回 NSIS、最后签安装包的实际流程。参考 [NSIS 外部签名说明](https://nsis.sourceforge.io/Signing_an_Uninstaller_externally)。获准接入前不添加尚未验证的签名命令或凭据。

## 已准备的申请材料

- [英文申请草稿](signpath-application-draft.md)：按实际表单字段准备项目名、介绍、信誉证据、公开链接；另有完整英文资格询问稿。
- [Code signing policy 准备稿](code-signing-policy.md)：说明未签名现状、拟定角色、签名范围和数据处理边界。
- README 与[发布清单](release-checklist.md)增加材料入口，仍保持当前包未签名、未获批的说明。

实际表单已在 Chrome 中成功读取，含必填姓名、邮箱、项目说明、信誉说明、发现渠道，以及条款和个人数据处理同意项。没有填写任何字段、勾选同意、操作验证码或点击 Submit；也没有安装 GitHub App、添加密钥或向基金会发送消息。

表单要求下载页提及 SignPath，但当前并未使用其服务。资格询问稿已说明这个时间顺序问题，建议先确认可接受的待审批措辞；不得提前挂“已签名”或赞助标识来满足表单。

## 建议后续顺序与验收

1. 维护者审阅英文资格询问稿，正式发送前确定联系渠道及所用姓名/邮箱；信息不存入公开 Git。
2. 询问新项目信誉、PyMuPDF 双许可、OpenCV/Intel IPP、Paddle 原生 DLL、系统运行库、单维护者审批和 NSIS 流程。若 OCR 不符合，讨论先申请 Core 的可能性；收到明确答复前不更换已验收的 PDF/OCR 引擎，也不购买证书。
3. 资格方向明确后，再把 Core/OCR 打包接入独立 GitHub 托管 Windows 工作流，保留固定提交、依赖、测试与产物关联。只生成未签测试产物，不自动发布；完成后验证两个 edition 的内容和元数据各自正确。
4. 根据基金会要求配置签名账号、GitHub App 的最小仓库权限、人工批准和签名文件白名单。需要新的账户授权时展示具体权限；未获授权不自行创建或扩权。
5. 完成签名链/时间戳验证、NSIS 安装后文件核验和干净 Windows 验收后，按新的公开版本交付签名资产，最后生成最终哈希与记录。

本次文档验证采用差异/链接检查、公开文件扫描和事实一致性复核。没有重跑产品测试或构建 NSIS，因为应用、依赖和构建行为均未修改。

## 资料来源

- [基金会条件与角色要求](https://signpath.org/terms)
- [实际申请入口](https://signpath.org/apply)
- [GitHub 构建来源验证](https://docs.signpath.io/trusted-build-systems/github)
- [签名文件配置与第三方文件排除](https://docs.signpath.io/artifact-configuration/)
- [现有公开源码 CI](https://github.com/flydommm/bank-receipt-workbench/actions/runs/34526176098)
- [当前预发布交付记录](public-release-0.1.27.md)

GitHub 项目与发布信息采用当日 API 响应核对，网页搜索缓存可能落后于当前 `main`。上面的日期、版本、信誉计数仅代表本次评估时点。
