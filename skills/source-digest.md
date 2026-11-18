---
name: source-digest
description: 读几个网页，写一份摘要，把「资料怎么说」和「我的结论」分开写。
when_to_use: 有人让你上网查一个问题、写一份简短的书面说明的时候。
inputs:
  - 要查的问题
  - 1–5 个网址，或者一个搜索方向
steps:
  - 用 http_fetch 读每个网址（只能是公网地址；内网和本机地址会被挡住）。
  - 写 notes/sources.md，列出每个网址、状态码和原文摘一句。
  - 写 notes/digest.md，先写「资料怎么说」，再写「我的结论」。
  - 结论以后还用得上，就用 memory_write 记到共享记忆里（scope 写 "shared"）。
  - 用 task_finish 结束，写明摘要文件的位置。
validation:
  - 「资料怎么说」里的每一句，在 notes/sources.md 里都有对应的原文。
  - 摘要不超过 60 行。
output: notes/sources.md 和 notes/digest.md。
approval_notes: 读网页是中风险。研究员默认可以直接读；别的助手读之前会先问你。browser_open 要先配好浏览器（CHROME_PATH），没配时什么都不做。
---

# 资料摘要

## 唯一的规矩

先摘原文，再下结论，两部分分开写、一眼看得出来。分不清哪句是资料说的、哪句是你说的，这份摘要还不如没有。

## 篇幅

最多读五个网页、写六十行。问题需要更多，就是两件事，第二件要说清楚。

## 上不了网的时候

直接说上不了网，然后停下。不要凭记忆补上、再说成是查来的——这个技能就是为了防这一种错。
