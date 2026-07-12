@echo off
rem Copy this file to local.env.bat, then fill in your own private values.
rem local.env.bat is ignored by Git and should not be uploaded.

set "QPL_TRANSLATION_ENABLED=1"
set "QPL_TRANSLATION_PROVIDER=qwen"
set "QWEN_API_KEY=replace-with-your-qwen-api-key"
set "QPL_QWEN_BASE_URL=https://your-bailian-openai-compatible-url/compatible-mode/v1"
set "QPL_QWEN_MODEL=qwen-plus"
set "DEEPSEEK_API_KEY=replace-with-your-deepseek-api-key"
set "QPL_DEEPSEEK_MODEL=deepseek-v4-flash"
