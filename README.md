# Manga Realtime Translator (MV3)

一个可直接加载运行的 Edge/Chrome 扩展：在漫画网站自动识别 `img/canvas`，通过百度 OCR 或本地 PaddleOCR 识别文字，再调用 OpenAI-compatible 文本接口翻译并将中文覆写到原图位置。支持覆盖层显示，也支持把译文真实绘制进图片/画布的嵌入式改图模式。

## 功能总览

- Manifest V3：`background service worker + content script + popup`
- 自动检测漫画目标：
  - `MutationObserver` 监听懒加载和动态节点
  - `IntersectionObserver` 仅处理进入视口目标，节省 API 成本
  - 支持 `img` 与 `canvas`
  - 尺寸/比例过滤小图，减少头像/广告误触发
- 数据提取与跨域处理：
  - 优先 background 中 `fetch` 图片（跨域更稳定）
  - 统一转 Data URL（优先 JPEG，必要时回退 PNG）
  - Popup 可切换取图模式：直接覆盖或截图覆盖
  - 遇到 `image format not supported` 自动转 JPEG 重试
- OCR + 翻译 provider：
  - `baidu_deepseek`（百度 OCR 含位置识别 + OpenAI-compatible 文本翻译，保留历史 provider 名）
  - `local_paddle_deepseek`（本地 PaddleOCR + OpenAI-compatible 文本翻译，保留历史 provider 名）
- 全局术语库：
  - 从 popup 打开独立管理页，支持搜索、增删改、启停和 JSON/CSV 导入导出
  - 当前 OCR 文本命中的启用术语会作为强约束注入翻译提示词
  - 修改、停用或删除术语后自动使用新的缓存身份，不会继续复用旧译文
- 覆写渲染：
  - 按百分比坐标绝对定位覆写层
  - 字号按气泡高度比例自适应（带 clamp）
  - 点击气泡可切换原文/译文
  - 区分 `bg_type: solid | transparent | none`
- 嵌入式改图：
  - Popup 可切换“嵌入式改图：生成译文图片”
  - `img` 会合成一张带译文的新图片并替换当前图片显示
  - `canvas` 会直接把译文绘制回当前画布
  - 切回覆盖层或关闭扩展时会尽量还原原始图片/画布
- 稳定性：
  - `chrome.storage.local` 缓存翻译结果，同图避免重复请求
  - 内容脚本单例保护，避免重复注入冲突
  - 处理扩展热更新后 `Extension context invalidated`
  - 滚动/回滚后覆写层可自动重定位恢复（包含 canvas 场景）
  - 错误集中在 popup 状态展示，不在页面反复刷提示

## 目录结构

```text
translator/
├─ manifest.json
├─ background.js
├─ content.js
├─ popup.html
├─ glossary.html           # 全局术语库管理页
├─ glossary-core.js        # 术语规范化、命中与提示词规则
├─ local-ocr-service/      # 可选本地 PaddleOCR 服务
├─ popup.js
├─ styles.css
└─ README.md
```

## 安装步骤（Edge / Chrome）

1. 打开扩展管理页：
   - Edge: `edge://extensions`
   - Chrome: `chrome://extensions`
2. 打开“开发者模式”。
3. 点击“加载解压缩的扩展程序”。
4. 选择本项目目录：`C:\homework\AI_work\translator`。

## 配置说明（Popup）

1. 点击工具栏扩展图标，打开 popup。
2. 填写：
   - Provider：`baidu_deepseek` 或 `local_paddle_deepseek`
   - Model：OpenAI-compatible 文本翻译模型名，例如 `deepseek-chat`
   - API Key：文本翻译接口 Key
   - Base URL：文本翻译接口地址，例如 `https://api.deepseek.com`
3. 勾选“启用悬浮球翻译”。
4. 选择取图模式：
   - 直接覆盖：优先读取原图、canvas 或背景图数据，再把译文覆盖回原位置。
   - 截图覆盖：截取目标当前可见区域做 OCR/翻译，再把译文覆盖回这块可见区域。
5. 选择渲染模式：
   - 覆盖层：译文浮在原图上，点击气泡可切换原文/译文。
   - 嵌入式改图：生成带译文的新图片，文字会真实绘制进画面。
6. 点击“保存配置”。

### 百度 OCR + OpenAI-compatible 翻译示例

- Provider：`baidu_deepseek`
- Model：`deepseek-chat`
- API Key：填写翻译接口 API Key
- Base URL：`https://api.deepseek.com`
- 百度 OCR API Key（AK）：填写百度智能云 OCR 应用的 API Key
- 百度 OCR Secret Key（SK）：填写百度智能云 OCR 应用的 Secret Key

该模式的位置来自百度 OCR 的文字框，翻译请求走 OpenAI-compatible Chat Completions 接口；适合想要“OCR 框 + 框内译文”的场景。

### 本地 PaddleOCR + OpenAI-compatible 翻译示例

- 先按 `local-ocr-service/README.md` 启动本地 OCR 服务。
- Provider：`local_paddle_deepseek`
- Model：`deepseek-chat`
- API Key：填写翻译接口 API Key
- Base URL：`https://api.deepseek.com`
- 本地 OCR 服务地址：`http://127.0.0.1:8765`
- 本地 OCR 语言：`auto`、`japan` 或 `korean`

该模式 OCR 在本机执行，不消耗百度 OCR 调用次数；适合主要翻译日文或韩文漫画。

## 术语库

1. 在 popup 点击“管理全局术语库”。
2. 新增“原文术语”和“固定译文”；备注可填写角色身份、语境等补充信息。
3. 启用后的术语对所有网站生效。翻译时只发送当前 OCR 文本实际命中的术语，避免无关术语占用上下文。
4. JSON/CSV 导入采用合并策略：相同原文更新已有译法，新原文追加；导出文件可用于备份或迁移。
5. 术语库最多保存 500 条，单条原文和译文最多 120 字，备注最多 240 字。

## 使用方式

- 手动模式（两种）：
  - 点击页面右下角悬浮球“译”
  - 在 popup 点击“翻译当前视口”
- 覆盖层模式：点击任一覆写气泡可切换原文/译文。
- 嵌入式模式：译文会写入新图片或当前画布，适合条漫连续阅读。
- 截图覆盖模式只处理目标当前可见裁剪区域，适合无法直接读取像素的 canvas、跨域图片或页面保护较强的网站。

## 最小可复现调试步骤（含 bomtoon/canvas）

1. 安装扩展并配置好 API 参数。
2. 打开普通漫画图片页面（`img` 场景），滚动使图片进入视口。
3. 观察是否出现中文覆写；点击气泡验证原文/译文切换。
4. 打开 `canvas` 渲染漫画页面（如 bomtoon 阅读器）。
5. 先点击悬浮球“译”，再滚动上下，确认覆写层跟随恢复。
6. 如失败，打开 popup 查看“页面状态”；再看扩展 Service Worker 控制台日志。

## 调试要点

- 内容脚本日志：页面 DevTools Console，过滤关键字 `MangaTranslator`。
- 后台日志：扩展详情页 -> Service Worker -> Inspect。
- 常见问题：
  - `API Key is missing`：popup 未保存或字段为空。
  - 文本翻译接口请求失败：检查 Base URL、Model 和 API Key 是否与 OpenAI-compatible 接口匹配。
  - `image format not supported`：仅与本地模式的可选低置信度 Vision OCR 有关；代码会自动转 JPEG 重试。
  - `Extension context invalidated`：通常是热更新后旧上下文失效，重新注入后会恢复。

## 关键实现备注

- OCR 与翻译分层执行：OCR 负责文字和区域定位，`buildOpenAICompatibleTranslationPrompt()` 负责批量文本翻译。
- 启用术语按原文长度降序匹配，命中后要求模型严格使用指定译文；术语有效内容的指纹同时进入整图和文本块缓存键。
- 统一输出结构：

```json
{
  "bubbles": [
    {
      "x": 12.5,
      "y": 20.2,
      "w": 30.1,
      "h": 12.8,
      "bg_type": "solid",
      "original_text": "...",
      "translated_text": "..."
    }
  ]
}
```

并支持模型返回 `[0,1]` 坐标自动缩放到 `[0,100]`。
