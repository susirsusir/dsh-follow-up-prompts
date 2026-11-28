# 更新记录

本文件记录 `dsh-follow-up-prompts` 的全部重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。英文版见 [CHANGELOG.md](CHANGELOG.md)。

## [Unreleased]

## [1.1.7] - 2026-11-28

### Added

- **`CHANGELOG.md` 成为版本记录的唯一出处。** 原来这些说明写在 README 里，容易和当前状态一起漂移；README 现在只留一行指向这里。
- **`CHANGELOG.zh-CN.md` 与英文版同步维护**，和两个 README 的中英双语保持一致。
- **`docs/RELEASE.md` 增加第 0 步**：先把改动写进 `[Unreleased]` 段，发版时再改成具体版本。

### Changed

- **README 只描述当前版本。** 按版本罗列的「有什么变化」小节已删除，截图移回开头的介绍段；历史交给更新记录。

## [1.1.6] - 2026-11-23

### Fixed

- **悬停卡片不会再滞留。** 悬停建议条后离开窗口，或新一轮把整行换掉时，卡片可能停在悬停那一刻记下的坐标上——它出现在对话正文中间的某个位置，并且不理指针移动，因为负责 `mouseleave` 的元素已经被卸载了。现在卡片在来源卡片卸载、窗口失焦或页面隐藏、轮次切换、滚动和改尺寸时都会收掉状态；再加一层按 rAF 节流的指针移动校验兜底，漏掉的 `mouseleave` 也不会把它困住。键盘聚焦、250 毫秒延迟与卡片停在按钮上方的位置都没有变。

## [1.1.5] - 2026-11-23

### Fixed

- **npm 包补上了 1.1.4 承诺的东西。** 1.1.4 的 GitHub tarball 带有商店素材，但 npm 构建在修正 `files` 白名单之前就发布了，因此 `assets/`、`screenshots.json` 与发版清单缺失，按包名安装的人看到的 README 截图是断图。

### Added

- **`docs/RELEASE.md` 随包发布**，发版清单跟着代码走。

### Changed

- **README 改为按包名安装**：先 `plugin_manager install_bundle target=dsh-follow-up-prompts`，本地目录安装保留给开发，并补上对应的卸载命令。

## [1.1.4] - 2026-11-23

### Fixed

- **tarball 自带商店素材。** `assets/` 与 `screenshots.json` 加入 `files` 白名单；在此之前，包内 README 指向的截图并不在包里。

## [1.1.3] - 2026-11-23

1.1.1 与 1.1.2 是开发期的版本号、从未发布；它们的工作都在这里发布，这是 npm 上的第一个版本。

### Added

- **`suggestionModel` 配置**，可以固定模型选择：`auto`（默认）、`session`、`provider/model` 或 `model`。
- **失败会留痕。** 诊断日志区分「一直在沿用原模型」的 `suggest/model-kept`、「选中的模型不可用、已回退」的 `suggest/model-fallback` 与「撞上超时」的 `suggest/timeout`，而不是静默地少一行建议。`DSH_FOLLOW_UP_PROMPTS_TIMEOUT_MS` 可临时修改超时上限，便于调试。

### Changed

- **建议不再跑本轮的重模型。** 三条短指令不需要刚答完的重模型；复用它既慢又贵，而且在长会话里正是它把请求推过了超时线。`auto` 现在会在同一 provider 上挑一个轻量模型，provider 没有更便宜的模型时继续用本轮模型——最坏情况退化成旧行为，而不是没有建议。
- **超时从 20 秒提到 30 秒。** 长回合偶尔超过 20 秒才出第一个 token，就被中止、什么也留不下。

### Fixed

- **推理不再吃光答案预算。** 原请求继承了本轮的 `high` 推理档，却仍套着 600 token 的上限，推理模型把预算全花在思考上，返回的可见文本为空；现在推理档降到该模型声明的最低档，上限提高到 1024。请求也改走 `llm.prepareCall`，发出去的参数就是模型真正接受的那一套。

## [1.1.0] - 2026-11-23

### Added

- **写入面不可用时有可见提示。** 一旦持久化写入失败，提示条会换成「建议不可用」，而不是每轮静默地什么都不产出；悬停提示条可看到原因，写入恢复后自动回来。

### Changed

- **写入面带保护，测试过的 DSH 版本线被收紧。** `engines.dsh` 的上限停在 `0.3`，不兼容的升级会在安装或启用时就被发现，而不是等到某一轮才出错。

## [1.0.1] - 2026-11-23

### Fixed

- **持久化记录改为可忽略事件。** 记录写成 `plugin:dsh-follow-up-prompts/ready` 且带 `ignorable: true`，不认识这个类型的读取方会跳过它，而不是整份会话日志都打不开。旧的 `follow-up-prompts/ready` 类型仍然可读。

## [1.0.0] - 2026-11-23

首个公开版本。

### Added

- 每轮结束后在输入框上方给出最多三条后续指令，用本轮自己的用户与助手文本、在会话所属 provider 上生成。
- 点击一条可填入草稿；双击它或按 `↑` 立刻发送。
- 悬停卡片显示完整指令与使用说明。
- 建议放不下时可横向滚动，两端出现箭头；悬停显示 `×`，按 `Esc` 可收起本轮整行。
- 中英文展示元数据，颜色只用主题 token。

### Changed

- 以公开包名 `dsh-follow-up-prompts` 发布，`engines.dsh` 范围为 `>=0.2.2-rc.5 <0.3.0`。