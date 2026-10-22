"""manga-ocr 独立识别 worker：与主服务进程隔离，避免 torch/paddle 的 CUDA DLL 冲突。

Windows 上 torch 与 paddle 的 CUDA DLL 同进程互相加载失败（WinError 127，两种加载
顺序都试过），所以 manga-ocr 在自己的进程里跑：从 stdin 逐行读 JSON（{"images":
[base64 PNG, ...]}，一批一齐 generate），stdout 逐行回 {"results": [{text,
confidence}...]}。启动后先回一行 {"ready": true, "device": ...}。只 import torch/
transformers/PIL，绝不 import 本包（paddle）。

置信度不走 generate 的 output_scores——transformers 5.x 批量下 scores 的行与
sequences 的行不同序（实测 argmax 错乱），改用一次 teacher-forced 前向：logits[i]
预测 sequences[i+1]，按构造对齐，代价只是一次解码器前向。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys

def main() -> None:
    import torch
    from PIL import Image
    from transformers import AutoTokenizer, VisionEncoderDecoderModel, ViTImageProcessor

    model_name = os.environ.get("LOCAL_OCR_MANGA_OCR_MODEL", "").strip() or "kha-white/manga-ocr-base"
    processor = ViTImageProcessor.from_pretrained(model_name)
    # transformers 5.x 把 size:224 解释成「短边 224 + 中心裁剪 224×224」——竖排长列会被
    # 裁到只剩中间一小段（实测长正文列整列丢失、只剩 ruby 列读对）。manga-ocr 训练时的
    # 语义是**压扁**到 224×224（transformers 4.x 的行为），必须显式改回去。
    processor.size = {"height": 224, "width": 224}
    processor.do_center_crop = False
    # manga-ocr-base 的分词器是 BertJapaneseTokenizer（MeCab+字符级）；transformers 5.x
    # 的 fast 转换缺 sentencepiece 路径会失败，而 worker 只需要 decode（generate 产出
    # token id），慢分词器足够。decode 会在字间插空格，日文无空格，输出前去掉。
    tokenizer = AutoTokenizer.from_pretrained(model_name, use_fast=False)
    model = VisionEncoderDecoderModel.from_pretrained(model_name)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()
    pad_id = model.config.pad_token_id
    eos_ids = set(model.config.eos_token_id if isinstance(model.config.eos_token_id, (list, tuple)) else [model.config.eos_token_id] if model.config.eos_token_id is not None else [])
    print(json.dumps({"ready": True, "device": device}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            images = [Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB") for encoded in request.get("images", [])]
            results: list[dict[str, object]] = []
            if images:
                # 压扁后全部 224×224，批内无尺寸差，可直接拼批 generate。
                pixel_values = processor(images=images, return_tensors="pt").pixel_values.to(device)
                with torch.no_grad():
                    generated = model.generate(
                        pixel_values=pixel_values,
                        max_length=300,
                        return_dict_in_generate=True,
                    )
                    # teacher-forced 前向：logits[:, i] 预测 sequences[:, i+1]。重新过一次
                    # 编码器（encoder_outputs 复用在该模型上有维度坑），代价可忽略。
                    outputs = model(
                        pixel_values=pixel_values,
                        decoder_input_ids=generated.sequences[:, :-1],
                    )
                probabilities = torch.softmax(outputs.logits, dim=-1)
                results = []
                for row in range(len(images)):
                    token_ids = generated.sequences[row]
                    text = tokenizer.decode(token_ids, skip_special_tokens=True).replace(" ", "").strip()
                    per_token = []
                    for index in range(1, len(token_ids)):
                        token = int(token_ids[index])
                        if (pad_id is not None and token == pad_id) or token in eos_ids:
                            continue
                        if index - 1 >= probabilities.shape[1]:
                            continue
                        per_token.append(float(probabilities[row, index - 1, token]))
                    confidence = sum(per_token) / len(per_token) if per_token else 0.0
                    results.append({"text": text, "confidence": max(0.0, min(1.0, confidence))})
                # 批量解码的浮点归约顺序与单张不同，低裕度步可能被翻转并级联成空读/乱读
                # （实测 82 列里 7 列变空——同一批裁剪单张跑全对）。可疑行单独重跑一次，
                # 单张是基准；仍空说明那张图真的读不出。
                suspicious = [i for i, item in enumerate(results) if not item["text"] or item["confidence"] < 0.6]
                if suspicious:
                    retry_pv = processor(images=[images[i] for i in suspicious], return_tensors="pt").pixel_values.to(device)
                    with torch.no_grad():
                        retry_generated = model.generate(retry_pv, max_length=300, return_dict_in_generate=True)
                        retry_outputs = model(pixel_values=retry_pv, decoder_input_ids=retry_generated.sequences[:, :-1])
                    retry_probabilities = torch.softmax(retry_outputs.logits, dim=-1)
                    for j, i in enumerate(suspicious):
                        token_ids = retry_generated.sequences[j]
                        text = tokenizer.decode(token_ids, skip_special_tokens=True).replace(" ", "").strip()
                        per_token = []
                        for index in range(1, len(token_ids)):
                            token = int(token_ids[index])
                            if (pad_id is not None and token == pad_id) or token in eos_ids:
                                continue
                            if index - 1 >= retry_probabilities.shape[1]:
                                continue
                            per_token.append(float(retry_probabilities[j, index - 1, token]))
                        confidence = sum(per_token) / len(per_token) if per_token else 0.0
                        results[i] = {"text": text, "confidence": max(0.0, min(1.0, confidence))}
            print(json.dumps({"results": results}), flush=True)
        except Exception as exc:  # 单批失败不拖垮 worker
            print(json.dumps({"error": str(exc)}), flush=True)

if __name__ == "__main__":
    main()
