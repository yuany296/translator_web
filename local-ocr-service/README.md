# 本地 PaddleOCR 服务

日期：2026-06-05  
执行者：Codex

这个服务给浏览器扩展的 `local_paddle_deepseek` Provider 使用。OCR 在本机完成，不消耗百度 OCR 次数；翻译仍由扩展调用 DeepSeek。

## 安装

```bash
cd local-ocr-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows PowerShell:

```powershell
cd local-ocr-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 启动

```bash
python server.py
```

默认监听：

```text
http://127.0.0.1:8765
```

默认使用 CPU。安装 GPU 版 PaddlePaddle 后，可以通过环境变量切到 GPU：

```powershell
$env:LOCAL_OCR_DEVICE = "gpu"
.\.venv\Scripts\python.exe .\server.py
```

也可以使用 `auto`，服务会在 PaddlePaddle 支持 CUDA 时选择 `gpu:0`，否则回退 CPU：

```powershell
$env:LOCAL_OCR_DEVICE = "auto"
.\.venv\Scripts\python.exe .\server.py
```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

`/health` 会返回当前 `device` 和 `cuda` 状态。注意：机器有 NVIDIA GPU 不代表当前 Python 环境已经能用 GPU；如果 `cuda=false`，说明安装的是 CPU 版 PaddlePaddle，需要先换成 GPU 版。

## 自检

服务启动后，另开一个 PowerShell 运行：

```powershell
cd C:\homework\AI_work\translator\local-ocr-service
.\.venv\Scripts\python.exe .\check_ocr.py
```

如果要用真实漫画截图测试：

```powershell
.\.venv\Scripts\python.exe .\check_ocr.py --image "C:\path\to\sample.png" --lang japan
```

如果普通模式识别漏字，再单独测试增强模式：

```powershell
.\.venv\Scripts\python.exe .\check_ocr.py --image "C:\path\to\sample.png" --lang korean --enhanced --timeout 180
```

自检会依次检查 `/health` 和 `/ocr`。如果 `/health` 连接失败，说明服务没有运行或端口不可达；如果 `/health.ok=false`，说明 PaddleOCR 依赖导入失败；如果 `/ocr` 成功但 `items=0`，说明服务可用但当前测试图没有识别到文本。

默认 OCR 使用快速模式，只跑原图，避免扩展请求超时。增强模式会额外生成灰度增强和反色增强版本，耗时明显更长；结果里的 `variant` 字段可用于判断是哪一种输入识别出的文本。

## 扩展配置

- Provider：`local_paddle_deepseek`
- Model：`deepseek-chat`
- API Key：DeepSeek API Key
- Base URL：`https://api.deepseek.com`
- 本地 OCR 服务地址：`http://127.0.0.1:8765`
- 本地 OCR 语言：
  - `auto`：日文和韩文都跑一遍并按重叠框去重
  - `japan`：只跑日文
  - `korean`：只跑韩文

首次启动 PaddleOCR 会下载模型，耗时取决于网络和机器性能。

## GPU 说明

如果本机已有 NVIDIA GPU 和新驱动，可以安装 PaddlePaddle GPU 版来加速 OCR 推理。以 PaddlePaddle 3.3.1 + CUDA 12.6 wheel 为例：

```powershell
cd C:\homework\AI_work\translator\local-ocr-service
.\.venv\Scripts\python.exe -m pip uninstall -y paddlepaddle
.\.venv\Scripts\python.exe -m pip install paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
.\.venv\Scripts\python.exe -c "import paddle; print(paddle.device.is_compiled_with_cuda())"
```

输出 `True` 后再用 `LOCAL_OCR_DEVICE=gpu` 启动服务。GPU 主要改善速度；低对比暗底文字的漏检仍需要裁剪、预处理或检测参数优化。
