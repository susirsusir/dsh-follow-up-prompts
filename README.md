# dsh-next-suggestions

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that suggests what to do next, right above the composer.

After every completed turn the plugin asks the session's own model for up to three follow-up instructions and shows them as chips above the input box:

```
╭───╮ ┌──────────────────────────────────┬───┐ ┌──────────────────────────────┬───┐ ┌────────────┬───┐
│ › │ │ Summarize the diff and list risks│ ↑ │ │ Run the full test suite      │ ↑ │ │ Stop here  │ ↑ │
╰───╯ └──────────────────────────────────┴───┘ └──────────────────────────────┴───┘ └────────────┴───┘
```

- **Click the label** — the instruction is placed into the composer draft; edit it before sending.
- **Click ↑** — the instruction is sent immediately.
- **Click › / ‹** — when the chips do not fit, the row scrolls sideways. The right arrow jumps to the last suggestion, the left arrow jumps back to the first. Each arrow only appears when there really is more content in that direction; the scrollbar itself stays hidden.

## Requirements

- DeepSeek Harness with the `conversation.input.dock` slot (any recent desktop build).
- No runtime dependencies.

## Install

Install the folder as a bundle (a local folder install is linked, so edits to the source take effect after a restart):

```
plugin_manager install_bundle target=/absolute/path/to/dsh-next-suggestions
```

Then restart DeepSeek Harness so the Host and Client halves load.

## How it works

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `index.js` | Keeps the completed turn's user/assistant text per session, calls the model once after `turn/end` (`reason.kind === "completed"`), appends `next-suggestions/ready` to the session log. |
| Host | `index.js` | Folds that event into the `nextSuggestions` projection, which is what the client reads. |
| Client | `client.js` | Renders the chips in `conversation.input.dock` (order 30), using theme tokens only. |

Details:

- The model call reuses the session's provider/model and is capped at 600 tokens with a 20 second timeout.
- At most three suggestions are kept; the row scrolls sideways when they do not fit.
- Subagent sessions are skipped.
- On `turn/start` the previous row is cleared and any in-flight request is aborted, so stale suggestions never flash back.
- If the model returns something unparsable, the row simply does not appear.

## Privacy

The turn text is sent only to the provider and route the session already uses. Nothing else leaves the machine and there is no telemetry.

## Files

```
index.js            Host half
client.js           Client half
cordis.patch.yml    Bundle patch
locale/en.json      Display metadata (English)
locale/zh.json      Display metadata (Chinese)
docs/DETAIL.md      Detail page shown in the plugin list
icon.svg            Plugin icon
```

## License

MIT