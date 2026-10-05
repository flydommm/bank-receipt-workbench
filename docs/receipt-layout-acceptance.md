# 回单版式与批量分割验收矩阵

状态：目标模式实施中。本文定义完整功能的验收和证据格式；“拟新增”或待接入项目不能作为已通过的测试。它与[版式设计方案](receipt-layout-design.md)和实施 TODO（历史资料已归档）配套使用。P1 合同及 P2 几何模块的阶段证据记录在 TODO，尚不代表下表完整场景通过。现有[引导式微调与审核流程](guided-review-workflow.md)继续作为当前行为参考；方案实施后应按新的分阶段流程更新相关说明，不把旧的逐银行强制完成按钮作为本矩阵的通过条件。

## 通过规则和测试边界

每个稳定 ID 都要有可复现步骤、实际结果和保存的证据。状态只有以下三种：

- 通过：预期结果全部满足，且证据能对应本 ID。
- 失败：有一项预期不满足，或保存/恢复结果无法确定。
- 阻塞/跳过：环境、样本或依赖不足。阻塞和跳过都不算通过，必须在交付记录中说明原因和补测命令。

公开自动化测试只使用运行时生成的合成 PDF、虚构银行名称、虚构交易文本和固定几何数据。不要把真实银行 PDF、OCR 文字、截图、账号、客户信息、私有路径、缓存或日志加入仓库。具体数量只用于合成回归规模：SYN-LARGE 由测试生成若干 PDF，共 671 页、552 个候选回单；其中首栏 51、中栏 55、尾栏 56 共 162 个属于三轮版式保存，其余 390 个属于其他合成版式或范围，只用于验证隔离和排除。这些数字不代表任何客户资料。

版式身份至少由已核实的出具银行、实际回单版式、页面尺寸/方向和栏位结构共同决定。银行名称本身不能让不同版式自动联动；同银行的多个 PDF 只有在实际版式验证一致后才可批量应用。关键词只负责筛选回单，不能改变已经确认的几何框。

## 稳定验收矩阵

矩阵中的测试名建议在实现时以 [Axx] 前缀登记，避免重命名后无法追溯。已有相关测试只说明当前仓库已有相近保护，不能替代本次新行为的完整验收。

| ID | 范围与合成场景 | 通过条件 | 证据与当前状态 |
| --- | --- | --- | --- |
| A01 | PDF 实际页面几何 | 读取每页宽、高、方向以及 CropBox/非零原点；建议框使用 PDF 坐标，不受屏幕缩放影响。 | src/services/sourcePageInspection.test.ts、src/domain/reviewContext.test.ts；完整版式建议为拟新增。 |
| A02 | 栏数与统一高度建议 | 根据页面和版式证据建议栏数、统一高度和各栏距页顶起点；1/2/3 栏提供快捷项，4 栏合成反例验证可自定义正整数栏数；每个第 i 栏用稳定 slot_id，首/中/尾只是常用标签；显示建议依据；总高度、最小合法裁剪高度和各栏不重叠约束均满足；可解除统一高度并改为逐栏高度。横向并排/不规则网格明确提示不适用。 | 版式建议、约束和“解锁统一高度”为拟新增；生成三栏和四栏合成夹具。 |
| A03 | 无关键词模式 | 显式选择“分割全部回单”后以 selection_basis=occupied_slot 或 manual_slot 按检测到的实际回单输出；不伪造 match evidence，也不因搜索框为空误入关键词路径。 | src/App.test.tsx 的搜索/导出夹具可复用；完整无关键词分割为拟新增。 |
| A04 | 关键词模式共用几何 | 输入任意关键词后仍使用同一版式的栏位框，只改变入选回单；换关键词不会重算出另一套框。 | src/App.test.tsx、src/domain/receiptMatchGrouping.test.ts；共用几何的完整回归为拟新增。 |
| A05 | 原生单页单栏 | 原件能证明每页只有一张回单时保留整页候选；不能因启用统一高度而强行切掉页脚或留白。 | src/domain/batchCrop.test.ts 有整页保护相关测试；原生单栏识别矩阵为拟新增。 |
| A06 | 多联全命中和单张尾页 | 三栏页全部命中时仍输出三张单张框；尾页只有首栏一张时沿用首栏框；空白栏和“空白联无效”不导出。 | src/domain/batchCrop.test.ts 已覆盖部分尾页匹配；三栏全命中、空白过滤和导出结果为拟新增。 |
| A07 | 同银行、同版式、同位置跨 PDF | 同一银行的多个 PDF 中，只有实际版式和位置均验证一致的候选同步；首/中/尾栏分别可见且数量准确。 | src/domain/batchCrop.test.ts、src/App.guided.test.tsx 有相关跨 PDF 证据；完整三位置批量验收为拟新增。 |
| A08 | 不同银行和不同版式隔离 | 不同出具银行、未知银行、不同实际模板或页面结构不联动，即使标题或关键词相同。 | src/domain/batchCrop.test.ts 已有银行/模板拒绝测试；扩展尺寸、方向差异为拟新增。 |
| A09 | 用户版式约束 | 用户设置的框不得越出纸张；用户设置的相邻 slot 有正面积重叠时硬拦，并指出哪一栏和哪条边冲突。 | src/domain/batchCrop.test.ts 已有纸张/保护边界测试；统一高度和相邻 slot 约束为拟新增。 |
| A10 | 自动边界校准 | 自动识别边界过紧时允许用户确认新的版式框；校准后的框必须仍包含命中区域、纸张合法且不侵入相邻回单。 | 当前自动保护见 src/domain/batchCrop.test.ts；自动边界可校准、真实硬约束仍保留为拟新增。 |
| A11 | 槽位映射稳定 | 调整一张后，同位置目标按稳定 slot_id 和各栏距页顶的绝对几何应用，保持共同高度/位置；不使用 segmentNo 作为身份，不叠加标题 anchor 平移或重复变换；重复应用不累加偏移。 | src/domain/batchCrop.test.ts、src/domain/linkedCropSession.test.ts 已有相关单元测试；固定槽位版本为拟新增。 |
| A12 | 同一回单多次命中 | 同一回单命中多个关键词或多个文字块只保留一条回单记录；同页不同回单不合并。 | src/App.test.tsx 已有同候选去重和相邻候选 AND 隔离测试；纳入两种处理模式的矩阵为拟新增。 |
| A13 | 51/55/56 大轮次 | SYN-LARGE 中分别调整首栏 51、中栏 55、尾栏 56；仅改变当前栏起点时，每轮只预览/保存当前选定 slot，首栏轮次的 confirmed_slot_ids 只能包含首栏，中栏和尾栏不能被自动晋升；修改共享高度时，范围扩展为所有受影响位置，并使受影响的旧确认失效、要求新预览，任何一处不能静默丢失。 | `src/domain/guidedReview.test.ts` 已验证 51/55/56 在同一银行、同一版式下形成三个独立位置轮次及 162 项银行投影；`src/domain/linkedCropSession.test.ts` 已覆盖精确 51/55/56 的位置隔离、单轮原子批量和撤销；`src/App.guided.test.tsx` 仍有 80 个同版式候选异步轮次。桌面 UI 的精确三位置轮次、confirmed_slot_ids 和共享高度失效仍待 P7/P8。 |
| A14 | 切换中栏 | 从首栏完成后进入中栏，样本、绿框、右侧列表和状态全部切到中栏；准备阶段结束后不得回到首栏。 | src/components/GuidedReviewPanel.test.tsx 已有位置选择交互；异步准备后保持选择为拟新增。 |
| A15 | 批量目标可见 | 预览列出本轮所有受影响的 PDF/页/栏/片段；同版式同位置的自动确认且未人工修改实例默认全部纳入并显示数量；人工独立修改、保留整页等例外默认保留并逐项显示，可由用户明确纳入覆盖；任何排除都显示原因，不能静默排除。 | 当前审查组件有预览/失败状态测试；完整“影响集合与异常集合一致”为拟新增。 |
| A16 | 无需微调的正常路径 | 自动框正确时结果页主操作为“选择导出范围”，直接生成最终预览并导出；次操作为“调整版式”，不要求按银行或按栏位进入微调。 | src/components/GuidedReviewPanel.test.tsx 已验证导出优先、微调可选；方案落地后保持该测试并补无关键词路径。 |
| A17 | 分阶段界面 | 结果页主操作为“选择导出范围”，次操作为“调整版式”；进入版式调整后按首/中/尾栏切换，当前阶段只突出一个主按钮；高级边距等设置折叠，保存状态和异常始终可见；标题、正文和状态文字沿用统一字号层级，长文案不溢出。 | src/components/GuidedReviewPanel.test.tsx、src/components/ReviewActionCard.test.tsx 有按钮门控测试；窄屏控件换行/最小高度见 src/components/ReviewNavigator.test.tsx（47 项定向回归）。实际低分辨率、高 DPI 和长文案仍待人工验收。 |
| A18 | 草稿、预览、保存顺序 | 拖动/缩放/方向键只改草稿；确认后进入“本轮预览，尚未保存”；预览返回可继续调整；只有“保存本轮”才落盘。 | src/components/GuidedReviewPanel.test.tsx、src/components/ReviewActionCard.test.tsx 已覆盖部分顺序；整套版式流程为拟新增。 |
| A19 | 原子、幂等、撤销 | 仅改变当前栏起点时，一次保存包含样本和当前 slot 的全部实际目标；修改共享高度时，一次保存包含所有受影响位置；两种情况下失败都不产生部分写入，重复相同请求不重复应用，撤销只恢复本轮、不影响其他轮次/银行。撤销有常用版式联动时，先登记模板库来源 operation 的撤回标记并暂停所有仍引用被撤回确认 operation 的历史模板版本，再按同一 undo id 恢复审核，迟到请求必须因撤回标记被拒绝，不能复活。 | src/domain/reviewOperations.test.ts、src/domain/linkedCropSession.test.ts、src/App.guided.test.tsx 有相关保护；模板库/审核联动撤销为拟新增。 |
| A20 | 保存失败恢复 | 失败或响应不明确时停在可恢复状态；只能重试原目标集合或只读重载后放弃；不能把失败轮当成功，也不能用取消猜测写入结果。 | src/App.guided.test.tsx、src/components/GuidedReviewPanel.test.tsx 已有失败重试/重载；新保存协议为拟新增。 |
| A21 | 快照过期和来源变化 | 分析代次、来源 SHA、页数或搜索条件变化后，旧预览和旧轮次失效；保存不得写入新任务；必须以最新输入重建新预览快照。写入结果不明时先查询并用同一 operation id、同一目标集合重试；目标集合改变后必须重新生成 operation，不能把旧目标套到新快照。 | src/components/cropTemplateAdapter.test.ts、src/App.guided.test.tsx、src/App.persistent.test.tsx 有相关测试；统一版式流程为拟新增。 |
| A22 | 旋转、CropBox 和尺寸差异 | 合成 PDF 覆盖旋转页、CropBox 非零原点、方向变化、相同银行不同页面尺寸；坐标归一化正确，不能跨尺寸盲套历史框。 | 当前几何上下文测试覆盖身份校验；四类 PDF 夹具和人工预览为拟新增。 |
| A23 | Core/OCR 边界 | Core 只验证文字型/无 OCR 需求路径；OCR 版才运行 OCR 资源和模型检查；缺少 OCR 时明确阻塞，不把 Core 通过当成 OCR 通过。 | scripts/smoke-runtime.py、src/components/cropTemplateAdapter.test.ts 可作为入口；Core/OCR 分离矩阵为拟新增。 |
| A24 | 历史版式参考 | 保存人工确认的版式规则后，下一批仅在银行、实际版式、页面几何和用户工作范围验证一致时建议复用；用户可替换/重置。版式身份使用稳定证据和 slot_id，不用 segmentNo 或历史关键词；当前任务快照不因历史模板出现而改写，也不自动启用旧模板。 | src/domain/reviewHistory.test.ts 现有恢复/校验测试；跨任务版式库、快照不改写和显式启用为拟新增。 |
| A25 | 历史迁移和旧任务 | 旧审核记录不盲目继承为新版式；计算版本、字段缺失或来源不一致时要求用原始 PDF 新分析。模板记忆失败只显示“审核已保存、版式未记住”并可单独重试，不回滚已保存审核；模板更新生成新版本，停用只影响未来匹配，任务清理不误删版式或已保存审核。 | `tests/test_layout_template_store.py`、`tests/test_receipt_calibration_journal.py` 已覆盖版本递增、停用后未来匹配、模板替换不改写旧任务 `layout_definition`；真实任务清理与 Windows 验收仍待 P8。 |
| A26 | React 185 回归 | 生产 React 下连续至少 50 次缓存/进度更新不触发 Maximum update depth exceeded；大轮预览仍收敛，保存目标不变。 | docs/development.md 已记录历史故障和最低覆盖要求；生产原生点击回归与 51/55/56 组合为拟新增。 |
| A27 | 帮助与可达性 | 帮助中心按“进入微调→选择栏位→调整→预览→保存→下一位置/导出”解释；控件有可读名称，键盘和错误提示可达。 | src/components/HelpCenterDialog.test.tsx 可复用；GuidedReviewPanel 错误/状态通过 aria-describedby 关联反馈容器并有回归测试。键盘焦点顺序和生产 WebView2 仍待人工验收。 |
| A28 | 原件保护与公开树 | 原始文件只读；所有复现先复制并记录 SHA-256；公开树无业务 PDF、私有路径、账号、OCR 正文或缓存。 | scripts/audit-public-tree.py、发布清单和人工哈希记录；私有样本流程见下文，当前仅准备。 |
| A29 | 模板记忆与审核解耦 | 审核保存成功后才登记模板来源 operation；模板登记失败不改变审核成功状态。撤销先写模板库来源 operation 的撤回标记并暂停所有仍引用被撤回确认 operation 的历史模板版本，再执行审核 undo；撤回标记拒绝迟到请求。若暂停失败，不执行审核 undo；若模板已暂停但审核 undo 失败，显示“历史模板已暂停、审核撤销未完成”，使用同一 undo id 恢复，不能自动启用旧模板。 | src/domain/reviewOperations.test.ts、src/App.persistent.test.tsx 可作为协议回归入口；模板库登记顺序、暂停失败、审核撤销失败和迟到请求防护为拟新增。 |

## 公开合成测试执行顺序

实现阶段每次改动先跑窄范围，再跑跨层回归。下面的命令均从仓库根目录执行，不能以“测试被跳过”作为通过：

~~~powershell
bun install --frozen-lockfile
$receiptLayoutVenv = Join-Path (Get-Location) '.venv'
if (-not (Test-Path (Join-Path $receiptLayoutVenv 'Scripts/python.exe'))) {
  py -3.12 -m venv $receiptLayoutVenv
}
$receiptLayoutPython = (Resolve-Path (Join-Path $receiptLayoutVenv 'Scripts/python.exe')).Path
& $receiptLayoutPython -m pip install --requirement engine/requirements-dev.txt

# 版式、匹配、历史、保存和界面窄回归
bun run test:web -- src/domain/batchCrop.test.ts src/domain/linkedCropSession.test.ts src/domain/receiptMatchGrouping.test.ts src/domain/reviewHistory.test.ts src/domain/reviewContext.test.ts src/domain/reviewOperations.test.ts src/components/GuidedReviewPanel.test.tsx src/components/ReviewActionCard.test.tsx src/components/ReviewOperationTools.test.tsx src/App.guided.test.tsx

# 前端完整公开测试
bun run test:web

# Python 合成测试；不要使用默认 python 代替 3.12
& $receiptLayoutPython -m pytest tests

# Rust/桌面进程边界测试必须绑定同一个 3.12 解释器
$env:PDF_SEARCH_TEST_PYTHON = $receiptLayoutPython
cargo test --manifest-path src-tauri/Cargo.toml --locked

# 类型检查和生产构建
bun run build

# DCO 工作流本地合同
node --test scripts/check-dco.test.cjs
~~~

当前准备环境核查结果：bun 为 1.3.14，py -3.12 为 Python 3.12.10；仓库 .gitignore 已忽略的独立 .venv 当前为 Python 3.12.10、pytest 8.4.2，pip check 已通过。默认 python 指向 Python 3.14，不能直接拿来绑定 Rust 测试；实施阶段只使用该独立 .venv，不修改系统 pip，也不要无条件重建已有环境。新增测试应明确断言几何、状态、目标集合和导出页数，不能只断言按钮存在。

实现 A22 后，再执行运行时合成冒烟：

~~~powershell
$privatePython = '.\.build\runtime\python\python.exe'
& $privatePython -B -I -X utf8 .\scripts\smoke-runtime.py --resource-root .
~~~

OCR 资源准备后才允许单独记录 OCR 证据；没有资源时该命令只能记录为阻塞：

~~~powershell
& $privatePython -B -I -X utf8 .\scripts\smoke-runtime.py --resource-root . --ocr
~~~

## 私有真实样本人工流程

本轮准备阶段只对真实样本做只读盘点，没有打开应用复现或加工原件。未来人工验收时，真实样本只用于本机验证，不能成为公开自动化夹具；先建立独立副本，应用只打开副本，复现完成后再核对原件 SHA-256 与盘点记录，不把路径写入文档、Issue 或日志。

1. 准备阶段只读记录文件名、字节数、页数（如可读）和 SHA-256，不打开应用、不改名、不移动、不覆盖；盘点结果放在受控本机目录。
2. 在独立临时目录创建副本，应用只打开副本。副本应保留原页面尺寸、旋转和 CropBox；不要用截图替代 PDF，也不要覆盖原目录。
3. 先验证 A16：自动框正确时直接导出。随后分别验证无关键词“分割全部回单”和关键词筛选；记录候选总数、实际输出回单数和异常数。
4. 对包含首栏、中栏、尾栏的同一实际版式，先查看程序读取的页面尺寸、方向、栏数、统一高度和各栏起点。确认建议后再调整；验证解除统一高度时不会隐藏或删除其他栏位。
5. 选择首栏样本，预览整批同银行同版式同位置目标；再分别切换中栏和尾栏。检查准备结束后仍停在选择的栏位，且右侧列表与预览数量一致。
6. 特别抽查三栏页全命中、尾页单张、空白/无效栏和相邻回单。确认框完整包含抬头、交易内容、印章、二维码及末行，不把下一张抬头带入。
7. 保存前记录预览目标清单摘要；保存后核对相同摘要、输出页数和状态数量。重复保存一次应无重复变化；撤销一次只回退本轮，再次预览应可重做。
8. 人为制造页外和相邻栏重叠，确认硬拦并显示冲突边；把自动边界向内/向外校准到合法范围，确认可以预览并在整批中同步。
9. 修改来源副本、切换搜索条件或让预览快照过期，确认旧轮次停止写入并提供重试/只读重载提示。
10. 复现结束后对原件重新哈希并与第 1 步盘点记录比较；原件必须完全一致。保存人工记录时只保留脱敏截图、匿名样本 ID、摘要统计和 SHA-256 是否一致，不保留业务正文。

先在 PowerShell 建立本次独立副本，路径和哈希只保留在本机。每次使用新的目录，不能覆盖之前的样本或验收记录：

~~~powershell
$sourcePath = Read-Host '原始 PDF 完整路径'
$sourceFile = Get-Item -LiteralPath $sourcePath -ErrorAction Stop
if ($sourceFile.PSIsContainer) { throw '请选择 PDF 文件。' }
$beforeBytes = $sourceFile.Length
$beforeHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
$receiptLayoutWorkDir = Join-Path $env:TEMP ('receipt-layout-private-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $receiptLayoutWorkDir -ErrorAction Stop | Out-Null
$copyPath = Join-Path $receiptLayoutWorkDir 'source.pdf'
Copy-Item -LiteralPath $sourceFile.FullName -Destination $copyPath -ErrorAction Stop
$copyHash = (Get-FileHash -LiteralPath $copyPath -Algorithm SHA256).Hash
if ($copyHash -ne $beforeHash) { throw '副本与原件不一致，停止验收。' }
~~~

保留这个 PowerShell 会话，先在应用中仅打开副本完成测试，并把导出放入本次工作目录。实际测试结束后再执行以下核对，不要将两段连续执行冒充测试后验证：

~~~powershell
$afterBytes = (Get-Item -LiteralPath $sourceFile.FullName).Length
$afterHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
if ($beforeBytes -ne $afterBytes -or $beforeHash -ne $afterHash) {
  throw '原始 PDF 在测试期间发生变化，停止验收。'
}
~~~

## 性能计时与证据

性能验收测量桌面应用中用户实际等待的墙钟时间，每次同时记录操作系统、应用提交、Core/OCR edition、页面数、候选数、目标数、是否冷启动和是否命中缓存。至少分开记录：导入/哈希、关键词分析、页面几何与栏数建议、进入版式准备、批量预览、保存、撤销和导出。合成大规模基线使用 SYN-LARGE，不把私有样本数量写入公开记录。

先在同一提交内做冷启动 1 次和热缓存 3 次，分别记录阶段结果；再做基线比较，基线和候选分别记录完整源码 SHA，除源码版本外，保持相同机器、输入、edition、运行时与冷/热条件，不用平均值掩盖单次失败。Vitest/Cargo/build 的耗时只代表开发验证或构建时间，不能作为用户等待基准。

导入、分析、版式准备、批量预览、保存、撤销和导出，应在实际桌面构建中用应用阶段计时或外部墙钟记录。记录每阶段实际处理页数、缓存命中/重复检查次数及候选数；相同结果集合、相同异常检查均通过后，才比较耗时。失败、超时、资源缺失或测试被跳过单独列为失败/阻塞。真实样本不记录 OCR 正文。

每次证据按以下字段记录：稳定 ID、测试类型（公开合成/私有人工）、代码提交完整 SHA、edition、运行时版本、命令或人工步骤、预期结果、实际结果、证据文件的本地路径、原件哈希前后一致性和状态。公开交付只提交不含业务数据的摘要；真实样本的截图和详细哈希表留在受控本机目录。

## 实施前提交检查

实施每个阶段结束后，先查看差异，再决定是否提交：

~~~powershell
git status --short --branch
git diff --check
git diff --stat
git diff -- docs/receipt-layout-design.md docs/receipt-layout-todo.md docs/receipt-layout-acceptance.md
py -3.12 scripts/audit-public-tree.py
node --test scripts/check-dco.test.cjs
~~~

提交前必须确认只包含授权改动、没有私有样本和本机路径；提交作者身份与 Signed-off-by 完全一致，使用 git commit -s。推送、合并 main、发布安装包和清理工作树属于后续独立动作，不是本验收文档的通过条件。

## 阶段证据索引

当前完成度以 TODO（历史资料已归档） 为准，矩阵不因模块测试通过而整体标记通过。P1 的跨语言合同夹具及 P2 的共用几何/选择器已经执行合成回归：

- `tests/test_production_pdf_geometry.py`：原生解析、线条/图片证据与生产导出坐标一致性；66 个用例覆盖旋转、页框、UserUnit、跨栏内容及源摘要不变。
- `tests/test_receipt_layout.py`、`test_receipt_batch_pdf.py`、`test_receipt_selection.py`：关键词无关实例、逐实例筛选、尾页参考、未知扫描槽位、风险保留和有界缓存。
- 具体命令、通过数量及异常处理见 TODO 的 P1/P2 实施检查记录，所属提交由 `git log --format=full -- docs/receipt-layout-todo.md` 定位。

以上不能作为新模式桌面保存/恢复、整批预览、历史参考、真实样本、性能或安装验收证据；这些项目必须在对应入口完成后另行记录实际结果。
