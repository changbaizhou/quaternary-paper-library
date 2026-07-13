# 第四纪论文库

本地优先的第四纪地质学论文研究工作台。论文 PDF、SQLite 数据库、笔记、标注和备份都保存在本机。

## 启动

Windows 可双击：

```text
启动论文库.bat
```

也可以手动启动：

```powershell
npm install
npm start
```

然后打开 `http://127.0.0.1:8000`。

启动脚本会继承用户级环境变量；若存在 `local.env.bat`，会在启动时加载它。OCR 工具路径不要写进批处理文件或仓库，使用环境变量配置。

## 上传与全文索引

上传 PDF 后先检查待确认草稿，再点击确认入库。确认时会自动建立页级全文索引。批量补齐 active 论文的页索引：

“导入文件夹”会读取所选目录及子目录中的 PDF，并沿用同一套待确认、去重、OCR 和入库流程；不会常驻监控文件夹，也不会上传非 PDF 文件。

```powershell
npm run index-library
```

单篇处理和失败重试：

```powershell
npm run index-library -- --paper 12
npm run index-library -- --retry-failed
```

索引前一定会创建数据库备份并登记 `bulk-index` 原因。任务逐篇运行；成功的页行会保留，失败论文不会写入新页，后续论文仍会继续。没有持久失败表时，`--retry-failed` 会安全地选择仍然没有页行的 active 论文。输出只包含论文 ID、状态和页数；有失败时命令以非零状态退出。

## 搜索与阅读

搜索范围包括：

- `全部`：元数据、全文页和笔记。
- `元数据`：题名、作者、摘要、分类等字段。
- `全文`：页级 PDF/OCR 文本。
- `笔记`：个人研究笔记字段。

全文命中会显示页码。点击结果会打开 PDF 阅读器并跳到命中页；页码输入框、上一页/下一页和书签也会定位阅读位置。扫描版 PDF 在 OCR 可用时会以页为单位补齐索引。

## 论文知识与术语

论文详情中的“论文知识”集中显示：

- 参考文献条目及已入库论文匹配；DOI 优先，题名仅做规范化精确匹配。
- 当前论文的引用、手动关系和同区域/同方法等本地相似关系。
- Figure、Fig.、Table、图、表题注及原文页码。

新建立的页级索引会自动重建这些派生数据。旧论文可统一重建：

```powershell
npm run rebuild-knowledge
npm run rebuild-knowledge -- --paper 12
```

该命令只重算派生索引，不修改 PDF、论文元数据、笔记或写作草稿。页头“术语”可维护规范词、别名、类别和释义；保存后别名立即参与本地语义扩展，关闭“语义扩展”时不生效。

## OCR

OCR 只调用本机 Poppler 和 Tesseract，不把整篇论文发送给 OCR 服务：

```powershell
where.exe pdftoppm
where.exe tesseract
tesseract --list-langs
$env:QPL_OCR_ENABLED="1"
$env:QPL_OCR_LANG="chi_sim+eng"
$env:QPL_OCR_PAGES="3"
npm start
```

可选变量包括 `QPL_OCR_DPI`、`QPL_PDFTOPPM_BIN` 和 `QPL_TESSERACT_BIN`。安装 OCR 后可重新处理旧数据：

```powershell
npm run reprocess
npm run index-library -- --retry-failed
```

## 标注与研究卡片

在阅读器文本层选择文字后，可以保存高亮、批注或摘录。标注包含论文、页码、引用文字和定位上下文，刷新后会恢复；侧栏中的标注和卡片可以跳回原页。摘录可以创建研究卡片，并编辑摘要、个人理解、主题和证据类型。

## 引用校验与格式

论文详情中的引用元数据可以校验。校验会报告缺失字段，不会猜造卷期、页码、出版社、DOI 或作者信息。可导出：

- GB/T 7714
- RIS
- CSL-JSON

导出前应检查引用状态和缺失字段。引用 key 在本地保持唯一，必要时可以显式重新生成。

## 项目与证据

可以创建多个研究项目，把同一篇论文加入多个项目，并分别设置优先级、立场、项目状态和备注。项目证据表汇总论文关系、分类和研究卡片，可按立场和证据类型筛选，显示支持/反对/混合统计，并直接修改项目关系；筛选后的证据仍可导出 CSV 或 Markdown。

每个项目有一个 SQLite 写作草稿。证据行中的“插入写作”会加入带页码的摘录和文中引用，同时维护已引用论文列表和参考文献预览。正文、标题和引用格式支持自动保存，也可点击“保存草稿”；切换项目或重启后仍会恢复。

## 翻译与研究问答

翻译只发送当前选中文字。研究问答只发送检索得到的页级片段，并为每个片段附带论文和页码出处；不会发送整篇 PDF、数据库、个人笔记或本地绝对路径。答案中的引用必须对应实际检索上下文，点击引用可跳到对应页，也可以把带出处的回答保存为研究卡片。

生产环境默认使用现有 Qwen 配置。把本地配置文件从示例复制出来后填写自己的值：

```bat
copy local.env.example.bat local.env.bat
```

`local.env.bat` 只应保存本机私密配置。README、源码、终端输出和 Git 中都不要写真实 API key；示例中的 key 必须保持占位符。

## 备份与数据位置

数据目录结构：

```text
library/
  library.sqlite
  files/
  backups/
```

数据库备份包含 SQLite 文件、校验清单和说明文件；完整备份还包含论文文件。恢复前会再次创建备份，并校验文件大小和 SHA-256。批量索引、恢复和其他破坏性操作都应先确认备份记录。

`local.env.bat` 永远不会进入数据库备份、完整备份或 Git；真实 library、真实 PDF、密钥和环境配置都不应提交。

## 测试

```powershell
node --test tests/indexLibrary.test.js tests/startScript.test.js
npm test
npm run test:browser
git diff --check
```

浏览器测试默认使用 Playwright bundled Chromium。若本机已有 Chrome，可设置：

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run test:browser
```

测试使用临时数据库、临时文件和生成的 PDF；外部翻译与研究 provider 均使用 mock，不联网。
