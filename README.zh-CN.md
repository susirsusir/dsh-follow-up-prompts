# dsh-follow-up-prompts

[English](README.md) | 简体中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：在输入框上方提示「接下来可以让我做什么」。

每轮回复正常结束后，插件用当前会话的模型再问一次，最多得到三条后续指令，以卡片形式显示在输入框上方：

```
        ┌──────────────────────────────────┬───┐ ┌──────────────────────────────┬───┐ ╭───╮ ╭───╮
        │ Add unit tests for the parser    │ ↑ │ │ Run the full test suite      │ ↑ │ │ › │ │ × │
        └──────────────────────────────────┴───┘ └──────────────────────────────┴───┘ ╰───╯ ╰───╯
```

每条建议只有一段文本：**卡片上看到的就是点击 ↑ 真正发送的内容**。指令控制在 50 字以内，所以每张卡都是固定高度的一行，不用省略号也能显示完整文案；卡片宽度由文案长度决定，几条并排时宽度并不相等。

- **点击文案** —— 这条指令被填进输入框，你可以先改再发（会替换当前草稿）。
- **点击 ↑** —— 直接发送这条指令。
- **点击 › / ‹** —— 建议放不下时，整行可以横向滚动。右箭头直接滑到最后一条，左箭头回到第一条。箭头只在对应方向确实还有内容时才出现，滚动条本身隐藏。
- **悬停后点击 ×** —— 收起本轮建议；按 `Esc` 同样收起。下一轮会重新出现。

## 环境要求

- 带 `conversation.input.dock` 插槽的 DeepSeek Harness（任意较新的桌面版本）。
- 无运行时依赖。

## 安装

把整个目录作为 bundle 安装（本地目录安装是软链接，改完源码重启即生效）：

```
plugin_manager install_bundle target=/absolute/path/to/dsh-follow-up-prompts
```

然后重启 DeepSeek Harness，让 Host 与 Client 两半都加载。

## 工作原理

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 按会话保留本轮的用户请求与助手回答，在 `turn/end`（`reason.kind === "completed"`）后调用一次模型，把 `follow-up-prompts/ready` 写入会话日志。 |
| Host | `index.js` | 把该事件折叠成 `followUpPrompts` projection，客户端读的就是它。 |
| Client | `client.js` | 在 `conversation.input.dock`（order 30）渲染卡片，只用主题 token 上色。 |

细节：

- 模型请求复用会话本身的 provider/model，最多 600 tokens，20 秒超时。
- 最多保留三条建议；放不下时整行横向滚动。
- 建议只有 `prompt` 一个文本字段，因此卡片文案与发送内容不可能不一致。
- 子会话（subagent）不产生建议。
- `turn/start` 时清空上一轮建议并中止未完成的请求，不会闪回旧内容。
- 模型输出解析失败时，这一行就不显示。

## 隐私

本轮文本只发给会话本来就在使用的 provider 与路由。除此之外不离开本机，也没有任何埋点。

## 文件

```
index.js            Host 半
client.js           Client 半
cordis.patch.yml    Bundle 补丁
locale/en.json      展示元数据（英文）
locale/zh.json      展示元数据（中文）
docs/DETAIL.md      插件列表里的详情页
icon.svg            插件图标
```

## 许可证

MIT