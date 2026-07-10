# Quaternary Paper Library

本地优先的第四纪地质学论文管理网页系统。

维护账号：`changbaizhou`

## 功能

- 上传 PDF，并复制到本地 `library/files/` 资料库。
- 自动提取 DOI、题名、作者、摘要、关键词等信息。
- PDF 文本抽取过少时，自动尝试本机 OCR。
- 可联网通过 DOI 或题名补全文献信息。
- 基于第四纪地质学词表自动推荐主题、区域、时期、材料、方法和指标。
- 待确认后入库，避免自动识别误差直接污染资料库。
- 支持题名、作者、摘要、分类和笔记检索。
- 支持导出 BibTeX、CSV、Markdown。

## 运行

```bash
npm install
npm start
```

打开：

```text
http://127.0.0.1:8000
```

## OCR

系统默认本地优先，不会把论文内容上传到外部 OCR 服务。扫描版 PDF 需要本机安装两个命令行工具：

- Poppler：提供 `pdftoppm`，用于把 PDF 页面渲染成图片。
- Tesseract OCR：提供 `tesseract`，用于识别图片文字。

Windows 安装后，把 `pdftoppm.exe` 和 `tesseract.exe` 加入 `PATH`，然后在 PowerShell 中检查：

```powershell
where.exe pdftoppm
where.exe tesseract
tesseract --list-langs
```

中文论文需要 Tesseract 的 `chi_sim` 语言包。建议启动前设置：

```powershell
$env:QPL_OCR_ENABLED="1"
$env:QPL_OCR_LANG="chi_sim+eng"
$env:QPL_OCR_PAGES="3"
npm start
```

可用环境变量：

- `QPL_OCR_ENABLED=0`：禁用 OCR。
- `QPL_OCR_LANG`：OCR 语言，默认 `chi_sim+eng`。
- `QPL_OCR_PAGES`：识别前几页，默认 `3`。
- `QPL_OCR_DPI`：PDF 渲染分辨率，默认 `220`。
- `QPL_PDFTOPPM_BIN`：自定义 `pdftoppm` 路径。
- `QPL_TESSERACT_BIN`：自定义 `tesseract` 路径。

如果 OCR 工具未安装，上传仍会成功，但扫描版 PDF 只能使用文件名兜底识别题名和分类。

## 重新处理旧文献

安装 OCR 后，可以重新处理已经入库或待确认的旧文献：

```powershell
$env:QPL_OCR_ENABLED="1"
npm run reprocess
```

脚本会先备份数据库到 `library/backups/`，再更新草稿和已确认论文的元数据与分类。

## 测试

```bash
npm test
```

## 数据位置

```text
library/
  library.sqlite
  files/
```

`library.sqlite` 和 `library/files/` 不会提交到 Git。
