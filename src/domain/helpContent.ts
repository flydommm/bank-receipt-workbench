import { APP_NAME, APP_SUBTITLE, APP_VERSION } from './appIdentity';

export type HelpTabId = 'overview' | 'guide' | 'feedback' | 'updates';

export type HelpTab = {
  id: HelpTabId;
  label: string;
  shortLabel: string;
  description: string;
};

export const HELP_TABS: readonly HelpTab[] = [
  {
    id: 'overview',
    label: '功能介绍',
    shortLabel: '功能',
    description: '了解银行回单工作台可以处理什么。',
  },
  {
    id: 'guide',
    label: '使用指南',
    shortLabel: '指南',
    description: '从导入 PDF 到导出结果的完整流程。',
  },
  {
    id: 'feedback',
    label: '使用反馈',
    shortLabel: '反馈',
    description: '整理问题并复制反馈文本。',
  },
  {
    id: 'updates',
    label: '版本与更新',
    shortLabel: '更新',
    description: '查看版本记录和当前安装方式。',
  },
] as const;

export const PRODUCT_IDENTITY = {
  name: APP_NAME,
  subtitle: APP_SUBTITLE,
  version: APP_VERSION,
} as const;

export const OVERVIEW_FEATURES = [
  {
    title: '按关键词找回单',
    description: '支持精确匹配和局部相似的模糊匹配，适合文字型或 OCR 识别后的银行回单。',
    tone: 'moss',
  },
  {
    title: '预览与凭证分割',
    description: '分析前先看原始 PDF，命中后在真实页面上调整裁剪框，再保留整页或裁出独立凭证。',
    tone: 'gold',
  },
  {
    title: '批量审核与导出',
    description: '可以按来源筛选、排序、批量应用同类裁剪，并导出合并版、来源版 PDF 和可选审核索引。',
    tone: 'navy',
  },
] as const;

export const GUIDE_STEPS = [
  {
    number: '01',
    title: '添加原始 PDF',
    body: '使用“选择 PDF”“选择文件夹”或“添加 PDF / 添加文件夹”导入材料。原始文件保持只读；导入后会自动显示第 1 页原始预览，也可以翻页查看。',
  },
  {
    number: '02',
    title: '填写搜索条件',
    body: '输入包含关键词，也可以设置排除关键词、包含关系和匹配精度。模糊匹配会在每个文本块内寻找局部相似片段，容许少量错字、空格和 OCR 误差。',
  },
  {
    number: '03',
    title: '开始分析并查看命中',
    body: '开始分析后，左侧“当前任务”只显示本次进度和来源，可在固定操作栏暂停或取消。点击“任务历史”才查看旧任务，点击“返回当前任务”继续查看本次进度。点击右侧命中片段预览，可用方向键切换、Home / End 跳到首尾。左栏勾选文件用于批量移除；只看某个来源的结果，请使用右侧“来源 PDF”筛选。筛选不自动改变导出范围。',
  },
  {
    number: '04',
    title: '复核与裁剪',
    body: '绿色框是候选凭证范围，黄色框是关键词命中位置。可以直接拖动当前凭证的绿框调整，保存成功后再确认当前片段或整组；已确认目标不会被同类批量调整覆盖，测试批量覆盖时可恢复自动候选使目标回到“需复核”。',
  },
  {
    number: '05',
    title: '应用同类片段和撤销',
    body: '先调整一张样本，再用“应用到同类片段”检查其他需复核且未改动的目标，查看旧框与新框后应用。一次批量应用算一步撤销，样本此前的调整仍保留。“撤销上一步”保存当前任务最近 20 步成功操作；切换任务、重新分析或重启后不保留，撤销后需重新确认整组。',
  },
  {
    number: '06',
    title: '选择导出范围',
    body: '确认结果后先填写文件名，再生成导出预览，最后选择输出目录保存；可以选择合并版、按来源版和可选的审核索引。',
  },
] as const;

export const RELEASE_NOTES = [
  {
    version: '0.1.27',
    status: '公开发布准备版',
    summary: '独立运行环境与公开文档整理。',
    details: [
      'Windows 安装包自带 Python 和 PDF 处理库，无需自行安装全局 Python。',
      '基础版适合文字型 PDF；扫描件请选择 OCR 版，首次识别可能联网下载公开模型。',
      '整理使用指南、依赖版本和开源准备记录，保留原始 PDF 只读处理与历史任务兼容。',
    ],
  },
  {
    version: '0.1.26',
    status: '已验收',
    summary: '扫描件文字复用与重复回单导出去重。',
    details: [
      '首次识别后在本机缓存文字和位置；同一文件更换搜索词或重启应用后可复用，仍重新查找并分析回单范围。',
      '同一文件、同一页、裁剪范围完全相同的回单只输出一次，审核记录和索引逐条保留。',
      '帮助中心可查看和清理识别缓存；原始 PDF、任务和已导出文件不受清理影响。',
    ],
  },
  {
    version: '0.1.25',
    status: '已交付',
    summary: '扫描件先识别文字，再定位和分割回单。',
    details: [
      'OCR 文字和坐标同时用于搜索与回单范围分析，修复扫描件只生成整页候选的问题。',
      '为文字识别单独启用 CPU 加速，文字位置检测保留兼容设置；实际耗时随页数和清晰度变化。',
      '沿用回单标题与正文的边界规则；识别或边界证据不足时仍需人工复核。',
    ],
  },
  {
    version: '0.1.24',
    status: '已交付',
    summary: '本地 OCR 兼容性、坐标适配和运行状态修订。',
    details: [
      '固定经过验证的 CPU 模型配置，修复扫描件推理异常和数组坐标被丢弃的问题。',
      '已安装与实际识别通过分开显示；可在帮助中心检测 OCR，运行故障显示分类提示并暂停后续处理。',
      '首次使用可能下载公开模型，PDF 在本机识别；图片扫描件的处理速度慢于文字型 PDF。',
    ],
  },
  {
    version: '0.1.23',
    status: '已交付',
    summary: '当前任务与历史任务分开显示。',
    details: [
      '开始分析默认展示当前任务进度和本次来源，旧任务通过“任务历史”入口查看。',
      '暂停、继续和取消操作保持固定可见；创建任务等待或失败时也不会显示旧任务作为本次来源。',
    ],
  },
  {
    version: '0.1.22',
    status: '已交付',
    summary: '帮助与反馈中心、入口调整和“银行回单工作台”品牌统一。',
    details: [
      '帮助内容随应用离线提供，不需要网络连接。',
      '应用名称统一为“银行回单工作台”，保留原有任务与设置标识。',
    ],
  },
  {
    version: '0.1.21',
    status: '已交付',
    summary: '样本反馈修订版。',
    details: [
      '新增导出文件自定义命名，继续保留来源筛选与结果排序。',
      '修复部分凭证边界、页数超限提示和审核坐标保存校验问题。',
    ],
  },
  {
    version: '0.1.20',
    status: '稳定版',
    summary: '银行回单查找、预览、审核、裁剪和导出闭环。',
    details: [
      '支持文件夹和多 PDF 任务、分析前原始 PDF 预览、键盘导航和任务历史。',
      '支持审核状态、撤销、按来源筛选、批量调整和 PDF / XLSX 导出。',
    ],
  },
] as const;

export const PRIVACY_NOTE = '反馈预览只包含你填写的内容、应用版本和引擎 / OCR 状态，不会自动附加 PDF、账号、文件路径或日志。';
