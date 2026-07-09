# Quaternary Paper Library

本地优先的第四纪地质学论文管理网页系统。

## 功能

- 上传 PDF，并复制到本地 `library/files/` 资料库。
- 自动提取 DOI、摘要、关键词等文本信息。
- 可联网通过 DOI 补全文献信息。
- 基于第四纪地质学词表自动推荐主题、区域、时期、材料、方法和指标。
- 待确认后入库，避免自动识别误差直接污染资料库。
- 支持标题、作者、摘要、分类和笔记检索。
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

