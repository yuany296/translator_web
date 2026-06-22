# 视觉回归基线

日期：2026-06-22
执行者：Codex

## 目的

任何 OCR、分组、背景判断或渲染修改都必须用同一组真实截图比较，避免只修好一张图或只证明语法通过。

固定输入位于 `tests/fixtures/visual/`，来源是浏览器实际发送给本地 OCR 服务的 KakaoPage 图片：

- `kakao_solid_bubble.png`：白色气泡与三行正文。
- `kakao_blank_boundary.png`：跨切片边界但没有可渲染正文。
- `kakao_effect_title.png`：复杂背景标题与效果字。

`baseline.json` 保存图片 SHA-256、预期文本片段和允许的质量边界。图片内容被替换时测试会先因哈希变化失败，不能静默刷新基线。

## 四阶段检查

| 阶段 | 自动指标 | 防止的退化 |
| --- | --- | --- |
| OCR | 原始数、过滤数、预期文本片段 | 漏字、低置信噪声 |
| 分组 | 合并块数、重复率 | 重复识别、错误合并 |
| 背景 | 区域数量、最大区域面积比 | 异常大色块、误判实色背景 |
| 渲染输入 | 可渲染框数、越界框数 | 错位、框超出图片 |

页面全局坐标映射、跨图 owner 归属和覆盖层样式由 `tests/content_runtime.test.mjs`、`tests/background_runtime.test.mjs`、`tests/overlay_style.test.mjs` 继续验证。

## 运行方法

```powershell
conda activate manga-translator
python tools\run_visual_regression.py
node --test tests\content_runtime.test.mjs tests\background_runtime.test.mjs tests\overlay_style.test.mjs
```

只跑一个真实截图：

```powershell
python tools\run_visual_regression.py --case kakao_solid_bubble
```

禁止为了让测试通过而直接放宽 `baseline.json`。只有确认新结果在真实页面上更好，并记录新旧指标与截图证据后，才能更新基线。
