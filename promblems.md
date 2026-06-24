# 问题

1. 不知道是不是页面太碎，总是会漏掉页面没有传进去，也可能是别的问题，但是总之呢，会漏掉一些页。
2. 拼接的时候会有的页面会重复传两次。现在不知道是不是修好了，好像是修好了。
3. 会出现红蓝调试框对不齐原漫画文字的情况，高度会拉长，不知道和上面两个有没有关联。

# 解决操作

## 1. 先确认问题发生在哪一段链路

不要直接改阈值或拼接规则，先在 KakaoPage 链路里加一次诊断日志，确认页面是在下面哪一步丢失或重复：

1. 页面候选收集：检查 `collectKakaopageManualTargetCandidates` 是否收到了所有漫画图片。
2. 自动入队：检查 `queuePageAutoTranslate` 是否因为 `mtLastTranslatedKey`、`mtNoTextKey`、`queuedTargets` 跳过了某些页。
3. 拼接请求：检查 `buildKakaoStitchedPayload` 是否把上一页、当前页、下一页拼进同一个 OCR 请求。
4. OCR 回映射：检查 `mapKakaoStitchedResult` 是否把拼接图坐标正确换算回当前页坐标。
5. 页面级去重：检查 `dedupeKakaoResultByPageCoordinates` 是否误删了正常文字框。

每一页都记录下面这些字段，方便判断漏页和重复页：

```text
index
targetKey
sourceToken
currentSrc
rect.top
rect.height
ocrMode
stitchKey
queued / skipped / requested / mapped / deduped
```

## 2. 处理漏页

1. 用 `sourceToken` 作为真实页面身份，`targetKey` 只作为当前 DOM 节点身份。
2. 自动翻译队列增加 `inFlightSourceTokens`，同一张原图正在请求时不重复入队。
3. 如果图片节点被网站复用，但 `currentSrc` 变了，要清掉旧 overlay、旧缓存和旧状态。
4. 短页不要单独 OCR，优先挂到相邻 owner 页一起拼接。
5. 给收集逻辑补测试：连续长页、短碎页、DOM 节点复用、滚动后新页进入视口都不能漏。

## 3. 处理拼接时重复上传

1. 拼接请求的唯一键使用 `sourceToken + previousSlice + nextSlice + neighborSourceToken`。
2. 对已经作为相邻页拼进 owner 的短页，写入 `mtKakaoAttachedToKey`，后续不要再作为独立页上传。
3. 请求发出前检查本地缓存、payload 缓存、正在请求集合，命中就复用结果。
4. 页面级去重只负责去掉跨页边界重复文字，不承担阻止重复上传的职责。
5. 补测试：同一 sourceToken 不能上传两次；短页被 owner 消费后不能再独立 OCR。

## 4. 处理红蓝调试框对不齐和高度拉长

1. 拼接 OCR 后，所有 debug 框都必须从拼接图坐标转换成 owner 页坐标。
2. `rawItems`、`dedupedItems`、`duplicateItems`、`finalBubbles` 使用同一套 `ownerDraw` 映射规则。
3. 不属于 owner 区域的普通邻页框要丢弃；明确标记为短页附着的框才允许显示到 owner 页边缘外。
4. 检查 `fill_box`、`polygon`、`region_polygon` 是否和 bubble 坐标使用同一个高度基准。
5. 如果框高度异常，比如单行文字高度超过合理阈值，就回退到单图 OCR 或丢弃该异常框。

## 5. 验证方式

1. 运行 `npm test`，确保现有运行时测试通过。
2. 增加或更新 `tests/content_runtime.test.mjs`，覆盖漏页、重复上传、短页挂载、debug 坐标回映射。
3. 用现有视觉回归工具检查红蓝调试框是否贴合原文字。
4. 验证通过后再提交本地 Git，不自动 push。
