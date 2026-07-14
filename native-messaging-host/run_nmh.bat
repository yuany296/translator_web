@echo off
setlocal

:: Find and activate conda (same logic as start_local_ocr_gpu.bat)
set "CONDA_BAT="
if exist "%ProgramData%\anaconda3\condabin\conda.bat" set "CONDA_BAT=%ProgramData%\anaconda3\condabin\conda.bat"
if "%CONDA_BAT%"=="" if exist "%USERPROFILE%\anaconda3\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\anaconda3\condabin\conda.bat"
if "%CONDA_BAT%"=="" if exist "%USERPROFILE%\miniconda3\condabin\conda.bat" set "CONDA_BAT=%USERPROFILE%\miniconda3\condabin\conda.bat"

if "%CONDA_BAT%"=="" exit /b 1

call "%CONDA_BAT%" activate manga-translator >nul 2>&1
if errorlevel 1 exit /b 1

:: Set environment variables for OCR
set "LOCAL_OCR_DEVICE=auto"
set "LOCAL_OCR_DISABLE_MODELSCOPE=1"
set "PADDLE_PDX_MODEL_SOURCE=bos"
set "PROJECT_ROOT=C:\homework\AI_work\translator"

:: Run the native messaging host (stdout goes to Chrome - keep it clean!)
python "%~dp0nmh_launcher.py"
