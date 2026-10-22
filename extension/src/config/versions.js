// v12：识别退化救援（`pipeline/degenerate_rescue.py`）——识别结果退化成符号/无意义文本
// （空、纯符号、低于识别下限）时，换该语言的**备用模型**对同一 crop 重试一次，重试结果
// 只有「实打实该语言文字 + 过识别下限」才替换原结果。现场：韩文气泡「응?」被
// korean_PP-OCRv5_mobile_rec 读成 "$?"（0.785）按符号噪声丢弃，备用 korean_PP-OCRv3
// 读出「응?"（0.718）；韩文没有 server 版模型（PP-OCRv5 通用模型不含 Hangul）。
// 返回的 items 内容变了而缓存键里看不见 → 必须换代次。
// v11：识别放大恢复 **2x 上限**（用户定版）。列拆分产出的窄列（12~23px）只放大到
// 24~46px，不再无上限冲到 48px——过度插值会把笔画糊掉。
// v10：本地服务 slice 主路径在检测合并后做**竖排列拆分**（服务端
// crop_columns.expand_vertical_column_detections，LOCAL_OCR_COLUMN_SPLIT=off 可关）。
// 检测框把「正文列+ルビ列/邻列出血」框成一个 crop 时，识别模型（单行）转横后看到
// 两行文字，会把两列打乱混读——「全部潰してこい」+「(ぜんぶつぶせ)」→「全部う潰い」
// (0.714) 就是它。拆分在识别之前按列带切成逐列检测，ルビ列交给客户端既有ルビ过滤。
// 另外放大加了几何门（短边 ≤11px 的碎条不放大，实测放大后 5/5 变差）。
// v9：本地服务 slice 主路径在识别前把短边 <48px 的识别 crop 用 LANCZOS 精确放大到
// 48px（服务端 preprocess.prepare_recognition_image，LOCAL_OCR_REC_PREPROCESS=off 可
// 关，LOCAL_OCR_REC_UPSCALE_MIN_SHORT_SIDE / LOCAL_OCR_REC_BORDER_PX 动态可调）。
// 识别模型把输入高度统一压到 48px：竖排台词列在整页位图收口后短边只剩 26~35px，
// 小字号假名（ャっぁ）在这一次重采样里丢掉——「スキヤンダルで」认成「スキンダルで」
// (0.997) 就是它。放大到正好 48 是实测最优点（放大过头会被模型缩回、反而丢字；
// 复制边会按比例挤占文字的有效高度，默认关）。识别输入变了、返回内容随之变化而
// 缓存键没变，所以必须换代次。
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
export const OCR_GEOMETRY_VERSION = "detect-crop-recognize-appearance-layout-v12";
export const OCR_COORDINATE_MODEL_VERSION = "crop-source-transform-v3";
export const TRANSLATION_PROMPT_VERSION = "canonical-zh-cn-v2";
export const WEBPAGE_TRANSLATION_PROMPT_VERSION = "webpage-zh-cn-v5";
