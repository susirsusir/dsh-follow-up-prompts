# dsh-follow-up-prompts

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that suggests what to do next, right above the composer.

After every completed turn the plugin asks a model on the session's own provider for up to three follow-up instructions and shows them as chips above the input box:

```
        ┌──────────────────────────────────┬───┐ ┌──────────────────────────────┬───┐ ╭───╮ ╭───╮
        │ Add unit tests for the parser    │ ↑ │ │ Run the full test suite      │ ↑ │ │ › │ │ × │
        └──────────────────────────────────┴───┘ └──────────────────────────────┴───┘ ╰───╯ ╰───╯
```

Each suggestion is a single piece of text: what you read on the chip is exactly what gets sent. Prompts stay under 40 characters; longer ones are cut at 40 characters with an ellipsis on the chip, and the full text is shown in the hover card. Chip width follows the text, so chips are not equally wide.

- **Click the text** — the instruction is placed into the composer draft; edit it before sending.
- **Double-click the text** — sends that instruction right away, without stopping in the draft.
- **Hover a chip** — after a moment a card appears above it with the full instruction and the rules of use (`Click to add to the input (double-click to send) · ↑ sends now`). The card is as wide as its content up to the composer width and never truncates; it ignores the pointer and disappears when you move away.
- **Click ↑** — the instruction is sent immediately.
- **Click › / ‹** — when the chips do not fit, the row scrolls sideways. The right arrow jumps to the last suggestion, the left arrow jumps back to the first. Each arrow only appears when there really is more content in that direction; the scrollbar itself stays hidden.
- **Hover, then click ×** — hides the row for the current turn. `Esc` does the same. While a right arrow is showing (more chips to the right), the `×` stays out of the way — the two share the same spot — and comes back once the row is scrolled to the end.

## Requirements

- DeepSeek Harness `>= 0.2.2-rc.5 < 0.3.0` (`engines.dsh`) with the `conversation.input.dock` slot. DSH refuses to install or enable a plugin outside that range unless a version exemption is granted for the exact pair.
- No runtime dependencies.

## Install

Published on npm as [`dsh-follow-up-prompts`](https://www.npmjs.com/package/dsh-follow-up-prompts), so it installs by name:

```
plugin_manager install_bundle target=dsh-follow-up-prompts
```

To work on a local checkout instead, install the folder — that install is linked, so edits to the source take effect after a restart:

```
plugin_manager install_bundle target=/absolute/path/to/dsh-follow-up-prompts
```

Then restart DeepSeek Harness so the Host and Client halves load. To uninstall, `plugin_manager remove_bundle target=dsh-follow-up-prompts`.

## What's new in 1.1.6

A hover tooltip could get stuck. If you hovered a suggestion and then switched apps — or a new turn replaced the suggestion row — the card stayed on screen at coordinates that no longer meant anything, and moving the pointer elsewhere did not dismiss it. The tooltip now drops its state when the card it came from unmounts, when the window loses focus or goes hidden, when the turn changes, and on scroll or resize; a pointer-move check backs all of that up. Restart to pick it up.

## What's new in 1.1.4

Packaging only, no behaviour change: the published tarball now ships its own storefront assets (`assets/icon-180.png`, `assets/screenshot-1.png`, `screenshots.json`), so the screenshot below renders inside the package too. Upgrading from 1.1.3 is just a restart.

![Three follow-up suggestions sitting above the composer, each with its own send arrow](assets/screenshot-1.png)

## What's new in 1.1.3

- **Suggestions no longer run on the turn's model.** A follow-up is three short instructions, and reusing the heavy model that just answered is slow, expensive, and — in long sessions — the thing that pushed the request past its deadline. The default `auto` picks a lightweight model on the same provider; if the provider offers nothing cheaper it keeps the turn's model, so the behaviour degrades to the old one instead of disappearing.
- **Timeout raised from 20 s to 30 s.** A long turn occasionally took longer than 20 s to produce its first token and was aborted with nothing to show.
- **Failures leave a trace.** The diagnostic log now distinguishes "kept the session model" (`suggest/model-kept`), "picked model was unusable, fell back" (`suggest/model-fallback`) and "hit the deadline" (`suggest/timeout`), instead of a silently missing row. `DSH_FOLLOW_UP_PROMPTS_TIMEOUT_MS` overrides the deadline for debugging.
- **New `suggestionModel` setting** to pin the choice: `auto` (default), `session`, `provider/model`, or `model`.

Upgrading is just a restart: existing installs keep the default `auto`, and nothing needs to be configured.

## How it works

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `index.js` | Keeps the completed turn's user/assistant text per session, calls the model once after `turn/end` (`reason.kind === "completed"`), appends `plugin:dsh-follow-up-prompts/ready` (marked `ignorable`) to the session log. |
| Host | `index.js` | Folds that event into the `followUpPrompts` projection, which is what the client reads. |
| Client | `client.js` | Renders the chips in `conversation.input.dock` (order 30), using theme tokens only. |

Details:

- The model call prefers a lightweight model from the session's provider (`auto` by default: ids containing `flash`/`mini`/`lite`/`small`/`instant`/`turbo`/`haiku`/`nano`/`fast` win; the session model is used when none is available), drops the turn's reasoning effort to the cheapest level the model declares (usually `off`, which DeepSeek maps to `thinking: disabled`), and is capped at 1024 tokens with a 30 second timeout. Suggestions are short copies, not reasoning tasks; leaving the turn's `high` effort on made reasoning models spend the whole budget thinking and return empty text.
- `suggestionModel` in the patch entry's `config` pins the choice: `auto` (default), `session` (keep the turn's model), `provider/model`, or `model`.
- At most three suggestions are kept; the row scrolls sideways when they do not fit.
- Suggestions carry one text field (`prompt`) only, so the chip text and the sent text can never diverge.
- Hovering the row reveals a close button; `Esc` also collapses it. The close button waits while the right arrow is showing, then returns at the end of the scroll. The row comes back on the next turn.
- Subagent sessions are skipped.
- On `turn/start` the previous row is cleared and any in-flight request is aborted, so stale suggestions never flash back.
- If the model returns something unparsable, the row simply does not appear.

## Compatibility and self-checks

Writing to the session log relies on two internal DSH methods (`session.publicationEntry()` and `session.commit()`) that have no public contract and may change across releases. The plugin handles that by:

- **Not spinning when writes are unavailable**: once the write surface is missing it skips the model call and logs one `[dsh-follow-up-prompts]` warning to the host log, instead of silently producing no suggestions every turn.
- **Never leaving a half-written event**: a failed write is only a diagnostic line; events always carry `ignorable`, so a reader that does not recognize the type skips it rather than refusing the whole session log.
- **Pinning the tested minor line**: `engines.dsh` stops at `0.3`, so an incompatible upgrade is caught at install/enable time.

Run the checks from the source checkout after upgrading DSH (both scripts ship with the repo, not with the npm package):

```
npm run canary     # read-only scan: are events still ignorable, is any legacy type present
npm run selftest   # fake host: write surface present/missing/throwing, model selection, timeout
```

`canary` exits non-zero only when it finds events that would make a session unreadable; it scans sessions modified in the last 14 days (`--days N`, `--all` for everything).

To see the notice row in the real UI, launch DeepSeek Harness with `DSH_FOLLOW_UP_PROMPTS_FORCE_UNAVAILABLE=1`: the plugin then treats itself as having no write surface, writes nothing, calls no model, and leaves only that row.

## Privacy

The turn text is sent only to the provider the session already uses. The one exception is an explicit `suggestionModel: <other-provider>/<model>`, which sends it to the provider you named. Nothing else leaves the machine and there is no telemetry.

## Files

```
index.js            Host half
client.js           Client half
cordis.patch.yml    Bundle patch
locale/en.json      Display metadata (English)
locale/zh.json      Display metadata (Chinese)
docs/DETAIL.md      Detail page shown in the plugin list
docs/RELEASE.md     Release checklist for bumping a version
scripts/canary.mjs  Post-upgrade check (read-only session-log scan)
scripts/selftest.mjs  Fake-host check of the write surface, model selection and timeout
icon.svg            Plugin icon
```

## License

MIT