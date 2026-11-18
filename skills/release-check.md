---
name: release-check
description: 发布前把工作区里的项目只读地检查一遍，给出「能发 / 不能发」。
when_to_use: 要发布、要把活交出去之前，或者有人问「这个能发了吗？」的时候。
inputs:
  - 工作区里的项目文件夹
steps:
  - 用 fs_list 看项目文件夹，确认该有的文件都在。
  - 用 shell 运行 "node --version"，记下检查用的运行环境。
  - 用 shell 运行只读的检查命令，比如项目有测试时运行 "node --test"。
  - 写 notes/release-check.md，每条命令记下：命令 / 退出码 / 输出。
  - 用 task_finish 结束，写「能发」或「不能发」，以及第一个没通过的检查。
validation:
  - notes/release-check.md 里每条命令都有退出码。
  - 只有所有退出码都是 0，才能说「能发」。
output: notes/release-check.md 和一句结论。
approval_notes: 执行命令是中风险，默认每条命令都会先给你看、等你批准。危险命令（rm -rf、sudo、shutdown、curl | bash 之类）是高风险，无人值守时直接不做。
---

# 发布前检查

只做只读的检查。这个技能从不修东西，只报告。

## 为什么每条命令都要人批准

执行命令是模型一旦糊涂就能真正搞坏东西的地方。每条都批准是这份安全的代价；这个代价很小，省掉它，麻烦就来了。

## 输出的样子

```
| 命令 | 退出码 | 说明 |
|---|---|---|
| node --version | 0 | v20.x |
| node --test | 1 | 2 个没通过 |
```

结论一行：`能发`，或 `不能发（node --test）`。
