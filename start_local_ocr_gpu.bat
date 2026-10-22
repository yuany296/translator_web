@echo off
setlocal

cd /d "%~dp0"

echo [local-ocr] Project: %CD%
echo [local-ocr] Activating conda environment: manga-translator
set "CONDA_BAT="
if exist "%ProgramData%\anaconda3\condabin\conda.bat" set "CONDA_BAT=%ProgramData%\anaconda3\condabin\conda.bat"
if "%CONDA_BAT%"=="" if exist "%USERPROFILE%\anaconda3\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\anaconda3\condabin\conda.bat"
if "%CONDA_BAT%"=="" if exist "%USERPROFILE%\miniconda3\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\miniconda3\condabin\conda.bat"
if "%CONDA_BAT%"=="" for /f "delims=" %%I in ('where conda.bat 2^>nul') do if "%CONDA_BAT%"=="" set "CONDA_BAT=%%I"

if "%CONDA_BAT%"=="" (
  echo [local-ocr] Could not find conda.bat.
  echo [local-ocr] Run from Anaconda Prompt or add conda to PATH.
  pause
  exit /b 1
)

call "%CONDA_BAT%" activate manga-translator
if errorlevel 1 (
  echo [local-ocr] Failed to activate conda environment manga-translator.
  echo [local-ocr] Conda launcher: %CONDA_BAT%
  pause
  exit /b 1
)

echo.
echo [local-ocr] Python executable:
where python
python -c "import sys; print(sys.executable)"
if errorlevel 1 (
  echo [local-ocr] Python check failed.
  pause
  exit /b 1
)

echo.
echo [local-ocr] Paddle GPU check:
python -c "import paddle; print('paddle:', paddle.__version__); print('cuda:', paddle.is_compiled_with_cuda()); print('device:', paddle.device.get_device()); paddle.utils.run_check()"
if errorlevel 1 (
  echo [local-ocr] Paddle GPU check failed.
  pause
  exit /b 1
)

set "LOCAL_OCR_DEVICE=auto"
set "LOCAL_OCR_DISABLE_MODELSCOPE=1"
set "PADDLE_PDX_MODEL_SOURCE=bos"
REM Recovery detection (2nd detect pass) runs only when primary finds fewer than 3 boxes.
REM Measured on KakaoPage slices: that pass added 0 boxes and cost about 120ms per slice.
REM NOTE: only "on-demand" is recognized; any other value keeps the old always-run behavior.
set "LOCAL_OCR_RECOVERY_DETECT=on-demand"
set "LOCAL_OCR_RECOVERY_MIN_PRIMARY=3"
REM Allow two same-type inferences to overlap on the GPU (reduces queueing while scrolling).
REM 2026-10-15: reverted to default 1 — this box shares the GPU with an Android emulator and
REM Ollama (8GB resident), only ~0.6GB VRAM free; a 2nd concurrent inference thrashed instead of helping.
REM set "LOCAL_OCR_PREDICT_CONCURRENCY=2"
REM debug 产物（每页 3 张整页 PNG + result JSON）默认关闭，每页可省 0.6~0.9s。
REM 需要排查识别效果时取消下一行注释，或在设置页打开"本地 OCR 调试"。
REM set "LOCAL_OCR_DEBUG_ALWAYS=1"

echo.
echo [local-ocr] Starting OCR service with LOCAL_OCR_DEVICE=%LOCAL_OCR_DEVICE%
echo [local-ocr] Entry: local-ocr-service\server.py
echo [local-ocr] Reason: local-ocr-service\README.md documents "python server.py" as the local OCR service startup command.
echo [local-ocr] URL: http://127.0.0.1:8765
echo.

pushd "%~dp0local-ocr-service"
python server.py
set "OCR_EXIT=%ERRORLEVEL%"
popd

if not "%OCR_EXIT%"=="0" (
  echo.
  echo [local-ocr] OCR service exited with code %OCR_EXIT%.
  pause
  exit /b %OCR_EXIT%
)

endlocal
