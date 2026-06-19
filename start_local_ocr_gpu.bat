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
