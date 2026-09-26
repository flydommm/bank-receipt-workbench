# 0.1.48 远端 Windows 定向 GUI 复检收口记录

状态：已完成本轮远端 Windows 0.1.48 定向 GUI 复检及证据核验。本记录只对列出的样本、操作和证据范围给出结论，不扩展为全量清单验收。

## 结论矩阵

| 复检项 | 本轮结论 | 关键证据 |
| --- | --- | --- |
| 版本、旧模板和重启后可见性 | 通过（GUI 核验范围） | `01-help-version.png` 显示 `v0.1.48`；`02`–`06` 记录既有模板；`48-restarted.png`、`49-restart-old-template-preserved.png` 显示重启后旧三栏回单模板 `v2` 仍可用；`50-restart-disabled-templates.png`、`51-ready-for-user.png` 完成收口 |
| 同一银行两套独立模板 | 通过 | `07`–`15`、`13-compact-saved-result.png`：华夏银行下 `048-HX-常用 v1` 与 `048-HX-紧凑 v1` 并存，均只确认 `slot1`；旧三栏 `v2` 仍可用 |
| 指定更新只影响目标模板 | 通过 | `17-common-update-result.png`、`18-common-v2.png`、`19-compact-unchanged.png`：常用升为 `v2`、首栏 `h=97.20`，紧凑仍为 `v1`、首栏 `h=96.50`，目标外模板和未确认栏位未被改写 |
| 多套匹配、显式选用、停用后自动匹配和新任务审核隔离 | 通过（审计范围） | `21`、`22`、`31`、`32`、`33`；`batch-behavior-audit.json/.md` 状态为 `passed` |
| 改名、停用和无恢复入口行为 | 通过（无恢复入口为产品行为） | `29-rename-result.png`、`33-disabled-template.png`、`50-restart-disabled-templates.png` |
| 跨银行/实际版式/特殊单证隔离 | 通过（本轮样本和安全边界范围） | `34`–`46`；批行为审计确认 187 页跨行兼容 pin 为空，MS 与特殊片段保持隔离 |
| 原件、工作副本和导出完整性 | 通过 | `integrity-comparison.json`、`43-remove-source-task-only.png`、`export-validation.json`、`46-two-hit-export-result.png` |

## 关键证据核验

截图位于 `.local-data/acceptance-0.1.48-remote-20260924/`；下列审计 JSON、审计脚本和导出渲染图位于该目录的 `evidence/` 子目录。业务 PDF 和数据库副本保存在本地忽略目录内，不纳入源码提交。

- `integrity-comparison.json`：34 个原件共 `184,629,039 B`，前后文件数、总字节数、manifest SHA-256 和逐文件内容均无变化；6 个工作副本 `HX-A/B/C`、`MS-A/B`、`SH-A` 的字节数与 SHA-256 全部相同。模板表由 14 行变为 17 行：旧 14 行逐字段不变、无删除或修改；新增 3 个版本属于 2 个系列，均为 `inactive` 且仅确认 `slot1`；5 条 withdrawal 记录逐字段不变。
- `batch-behavior-audit.json` 与 `.md`：数据库以只读、immutable、query-only 方式审计，状态为 `passed`，输入数据库前后哈希一致。HX-C 251 页全部存在两套候选且历史模板应用数为 0；显式紧凑模板和停用后常用模板均只确认 `slot1`，`slot2/slot3` 共 502 个未确认栏位逐条保持未套模板基线。旧任务的确认、特殊单证分类和排除记录保留；新任务 738 个 item 的 `current_record` 全部为 `None`，新旧 item ID 不相交。
- 同一批行为审计确认 MS-B 161 页与 SH-A 26 页共 187 页对华夏 pin 的兼容结果全部为空，未发生跨行模板套用；MS-B 482 条快照逐条不变。普通校准只影响 SH-A 的 20 个 `slot1` 页面，首栏从约 `93.00` 调为 `93.01 mm`；4 条上海特殊记录的确认状态、边界和确认时间不变，仅 `result_revision` 投影更新。
- 手续费精确查找审计通过：第 20 页 `slot2`、`slot3` 共 2 处命中。四个特殊片段分别为 SH 第 10 页贷款清算、第 18 页贷款利息到期通知书和第 26 页两张电子缴税；普通微调后仍保持确认与边界。

## 导出与最终 GUI 状态

- `export-validation.json` 验证唯一导出文件 `SH-A_手续费_查找结果.pdf`：`203,585 B`、2 页，每页 `595×265 pt`；两页均命中关键词。两页渲染检查确认回单标题、表格、印章和验证码完整，无主要内容裁切；本次没有 JSON 或 XLSX。
- 远端导出目录为 `D:\桌面保存\银行回单工作台\output\SH-A_手续费_查找结果_20260924_111915_20727b20`；导出文件与测试副本均保留供复查。
- `47-test-templates-disabled.png` 显示临时测试模板均已停用；`48-restarted.png` 完成重启；`49-restart-old-template-preserved.png` 显示旧三栏回单模板 `v2` 重启后仍可用；`50-restart-disabled-templates.png` 显示常用 `v2`、紧凑r `v1` 仍停用；`51-ready-for-user.png` 显示应用已回到导入分析空任务首页，默认分割全部回单并自动匹配，用户可继续使用。
- SH-A 身份未完成核验时，GUI 禁用“保存为模板”，并限定当前 PDF 使用；本轮普通页保存成功且没有失败提示。该结果证明安全限制有效，不称为跨文件识别修复。

## 范围边界

- 安装由用户在远端 Windows 完成；agent 实际核验的是帮助页显示 `v0.1.48` 及后续 GUI 行为，不宣称 agent 执行了安装器或完成独立清洁安装认证。
- 本轮没有单独注入“同银行不同公司、相同实际版式”的复用样本，也没有单独注入“同银行另一种普通实际版式”的样本；相关结论不超出本轮 HX/MS/SH 工作副本和审计证据。
- 本轮没有 GUI 注入失败保存、版本过期更新目标或其他故障恢复场景；工程测试结果不替代这些未注入场景。
- SH-A 身份不足属于安全限制：系统允许当前 PDF 的本轮处理，禁止保存为可跨文件复用的模板。本记录不把该限制写成识别问题已修复。
- 远端剪贴板同步延迟、数字框首击失焦和改名保存时窗口短暂最小化均通过工具侧恢复，未见异常退出证据，不作为应用崩溃结论。
