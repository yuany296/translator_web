// v8：送给本地服务的 `text_rec_score_thresh` 改成识别硬下限（0.4）而不是用户的结果筛选
// 阈值。服务端拿这个字段硬切识别结果，用用户阈值（默认 0.72）会把竖排长句里分数 0.70
// 出头、人类一眼能读的台词在识别阶段就删掉（实测「鉄パイプか」0.705/「帰ないと」0.711），
// 结果筛选里那条「有意义文本 + 面积正常就放行」的例外根本没机会生效。服务的返回内容变了
// 而缓存键没变，所以必须换代次（v7 的实底采样同理）。
// v7：本地服务对**实底容器**的采样留边单位改成字形尺寸（以前拿 item box 的长边当
// vertical_reference，竖排台词一「行」是一整列，留边直接外扩出气泡 → 结构门把几乎
// 每一行都拒了，同一页 19 行只有 1 行判成实底，其余全退化成 bg_type=none 用清理图，
// 用户看到「纯白气泡背景不干净」）。实底与清理图都进 OCR 结果，换代次才能让旧判定
// 作废。
// v6：日文识别模型从 japan_PP-OCRv3_mobile_rec 换到 PP-OCRv5（v3 在竖排漫画台词上
// 无论怎么预处理都只有 0.2~0.3 分）。这个版本号进 OCR 缓存键（ocr-dispatch.js#
// buildOcrCacheKey），换代次才能让已缓存的旧识别结果作废 —— 不换的话重启服务后
// 仍会读回旧的垃圾结果，看起来像"改了没用"。
export const OCR_GEOMETRY_VERSION = "detect-crop-recognize-appearance-layout-v8";
export const OCR_COORDINATE_MODEL_VERSION = "crop-source-transform-v3";
export const TRANSLATION_PROMPT_VERSION = "canonical-zh-cn-v2";
export const WEBPAGE_TRANSLATION_PROMPT_VERSION = "webpage-zh-cn-v5";
