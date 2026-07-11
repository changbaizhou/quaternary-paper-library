# 第四纪论文库

本地优先的第四纪地质学论文管理网页系统。维护账号：`changbaizhou`。

## 主要功能

- 上传 PDF，并保存到本地 `library/files/`。
- 自动提取 DOI、题名、作者、摘要和关键词；文本不足时可调用本机 OCR。
- 按第四纪地质学词表推荐主题、区域、时期、材料、方法和指标。
- 入库前人工确认识别结果，检测文件、DOI 和相似题名重复项。
- 显式保存论文元数据；个人笔记停止输入约 800 毫秒后自动保存。
- 连续滚动阅读 PDF，保存上次阅读页和每篇论文唯一书签。
- 将论文移入回收站后恢复或彻底删除。
- 创建数据库备份或包含 PDF 的完整备份，并在确认后恢复。
- 导出 BibTeX、CSV 和 Markdown。

## 启动

Windows 可直接双击：

```text
启动论文库.bat
```

也可以手动启动：

```powershell
npm install
npm start
```

然后打开 `http://127.0.0.1:8000`。

## 日常使用

上传 PDF 后先检查待确认草稿。系统发现重复项时只显示警告，不会自动合并或删除；可以打开已有论文、将草稿并入已有论文、放弃上传，或仍然单独入库。

论文详情中的题名、作者、分类等字段需要点击“保存更改”。个人笔记会自动保存，看到“已保存”后即可离开页面。

“回收站”用于恢复或彻底删除论文。彻底删除和清空回收站都需要第二次明确确认。

## 备份与恢复

备份保存在：

```text
library/backups/
```

数据库备份包含 `library.sqlite`、校验清单和说明文件。完整备份还包含 `files/` 中的论文原文件。系统校验文件大小和 SHA-256 后才允许恢复；恢复操作需要明确确认，并会先创建恢复前备份。

`local.env.bat` 永远不会包含在备份中，也不会提交到 Git。API Key 只应保存在这个本机文件中。

## OCR

扫描版 PDF 使用本机 Poppler 和 Tesseract OCR，不会把整篇论文发送到外部 OCR 服务。安装后确认以下命令可用：

```powershell
where.exe pdftoppm
where.exe tesseract
tesseract --list-langs
```

中文论文需要 Tesseract 的 `chi_sim` 语言包。常用设置：

```powershell
$env:QPL_OCR_ENABLED="1"
$env:QPL_OCR_LANG="chi_sim+eng"
$env:QPL_OCR_PAGES="3"
npm start
```

可选变量包括 `QPL_OCR_DPI`、`QPL_PDFTOPPM_BIN` 和 `QPL_TESSERACT_BIN`。OCR 不可用时上传仍会成功，但扫描件的自动识别效果会受限。

旧文献可在安装 OCR 后重新处理：

```powershell
npm run reprocess
```

脚本会先创建数据库备份，再更新草稿和已入库论文。

## 翻译

PDF 阅读器会自动翻译选中的文字，只把选中文字发送给翻译接口，不发送整篇 PDF、数据库或笔记。国内网络建议使用 Qwen 的 OpenAI 兼容接口。

将 `local.env.example.bat` 复制为被 Git 忽略的 `local.env.bat`，再填写自己的配置：

```bat
set QPL_TRANSLATION_ENABLED=1
set QPL_TRANSLATION_PROVIDER=qwen
set QWEN_API_KEY=你的_API_Key
set QPL_QWEN_BASE_URL=你的_OpenAI_兼容地址
set QPL_QWEN_MODEL=qwen-plus
```

系统也支持 Gemini 和 OpenAI，具体变量可参考 `local.env.example.bat`。不要把真实密钥写入源码、README、终端日志或 Git 提交。

## 数据位置

```text
library/
  library.sqlite
  files/
  backups/
```

数据库、论文文件、备份和 `local.env.bat` 均不会提交到 GitHub。

## 测试

```powershell
npm test
npm run test:browser
```

首次运行浏览器测试前安装 Chromium：

```powershell
npx playwright install chromium
```

若本机网络无法下载 Playwright Chromium，可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向本机 Chromium/Chrome 可执行文件后再运行测试。
