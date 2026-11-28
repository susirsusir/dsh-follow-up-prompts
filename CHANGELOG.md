# Changelog

All notable changes to `dsh-follow-up-prompts` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Chinese version: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## [Unreleased]

## [1.1.7] - 2026-11-28

### Added

- **`CHANGELOG.md` is now where version history lives.** These notes used to sit in the README, where they drifted from the description of the current state; the README now links here instead.
- **`CHANGELOG.zh-CN.md` mirrors this file in Chinese**, matching the two bilingual READMEs.
- **`docs/RELEASE.md` gained a step 0**: write the change under `[Unreleased]` first, then turn it into a version section when releasing.

### Changed

- **The README describes the current version only.** The per-version "What's new" sections are gone and the screenshot moved back into the introduction; history belongs to this file.

## [1.1.6] - 2026-11-23

### Fixed

- **The hover card can no longer get stuck.** Hovering a suggestion and then leaving the window, or letting a new turn replace the row, could leave the card on screen at coordinates captured when you hovered — it reappeared somewhere in the transcript and ignored pointer movement, because the element that owned the `mouseleave` handler had already been unmounted. The card now drops its state when its source card unmounts, when the window loses focus or the page goes hidden, when the turn changes, and on scroll or resize; a throttled pointer-move check backs those up so a missing `mouseleave` no longer strands it. Keyboard focus, the 250 ms delay and the placement above the chip are unchanged.

## [1.1.5] - 2026-11-23

### Fixed

- **The npm package now contains what 1.1.4 announced.** 1.1.4's GitHub tarball carried the storefront assets, but the npm build was published before the `files` whitelist was corrected, so `assets/`, `screenshots.json` and the release checklist were missing there and the packaged README's screenshot was broken for anyone installing by name.

### Added

- **`docs/RELEASE.md` ships in the package**, so the release checklist travels with the code.

### Changed

- **The README installs by name**: `plugin_manager install_bundle target=dsh-follow-up-prompts` first, with the local folder kept for development, plus the matching uninstall command.

## [1.1.4] - 2026-11-23

### Fixed

- **The tarball carries its own storefront assets.** `assets/` and `screenshots.json` were added to the `files` whitelist; before that the packaged README pointed its screenshot at a file that was not in the package.

## [1.1.3] - 2026-11-23

1.1.1 and 1.1.2 were version bumps during development and were never published; their work ships here, which is the first version on npm.

### Added

- **`suggestionModel` setting** to pin the model choice: `auto` (default), `session`, `provider/model`, or `model`.
- **Failures leave a trace.** The diagnostic log distinguishes "kept the session model" (`suggest/model-kept`), "the picked model was unusable, fell back" (`suggest/model-fallback`) and "hit the deadline" (`suggest/timeout`), instead of a silently missing row. `DSH_FOLLOW_UP_PROMPTS_TIMEOUT_MS` overrides the deadline for debugging.

### Changed

- **Suggestions no longer run on the turn's model.** Three short instructions do not need the heavy model that just answered; reusing it was slow, expensive, and in long sessions the thing that pushed the request past its deadline. `auto` now picks a lightweight model on the same provider and keeps the turn's model when the provider offers nothing cheaper, so the behaviour degrades to the old one instead of disappearing.
- **Timeout raised from 20 s to 30 s.** A long turn occasionally took longer than 20 s to produce its first token and was aborted with nothing to show.

### Fixed

- **Reasoning no longer eats the answer budget.** The request inherited the turn's `high` reasoning effort while keeping a 600-token cap, so a reasoning model spent everything thinking and returned empty text; the effort now drops to the cheapest level the model declares and the cap is 1024 tokens. The call also goes through `llm.prepareCall`, so the controls the model actually accepts are the ones sent.

## [1.1.0] - 2026-11-23

### Added

- **A visible notice when the write surface is unavailable.** Once a durable write fails, the row is replaced by "suggestions unavailable" instead of the plugin silently producing nothing every turn; hovering the notice explains why, and the row comes back when writes recover.

### Changed

- **The write surface is guarded and the tested DSH line is pinned.** `engines.dsh` stops at `0.3`, so an incompatible upgrade is caught at install or enable time instead of at some later turn.

## [1.0.1] - 2026-11-23

### Fixed

- **Durable records are ignorable events.** Records are written as `plugin:dsh-follow-up-prompts/ready` with `ignorable: true`, so a reader that does not recognize the type skips it instead of refusing to load the whole session log. The legacy `follow-up-prompts/ready` type stays readable.

## [1.0.0] - 2026-11-23

First public release.

### Added

- Up to three follow-up instructions above the composer after every completed turn, generated from the turn's own user and assistant text on the session's provider.
- Click a chip to put the instruction in the draft, double-click it or press `↑` to send it immediately.
- Hover card with the full instruction and the rules of use.
- Sideways scrolling with edge arrows when the chips do not fit, `×` (revealed on hover) and `Esc` to hide the row for the current turn.
- English and Chinese display metadata, theme tokens only for colors.

### Changed

- Published under the public package name `dsh-follow-up-prompts` with the `engines.dsh` range `>=0.2.2-rc.5 <0.3.0`.