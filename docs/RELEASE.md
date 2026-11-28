# 发版手册

把 `package.json` 的版本号往上抬一位之后，还需要走完这份清单。前半段（1–4）在本地完成，5–9 推到 GitHub 并对市场生效，第 10 节是 npm，第 11 节是市场侧。

## 发版前：先把改动写进更新记录

版本变更只记在 `CHANGELOG.md`（中文版 `CHANGELOG.zh-CN.md`，两版同步维护），README 里不再写「What's new」小节——README 讲的是**当前行为**，历史留在更新记录。

- 在 `## [Unreleased]` 下面按 `Added` / `Changed` / `Fixed` / `Removed` 归类写本次改动，条目用粗体起头，说清「以前怎样、现在怎样」，中英文各写一遍；
- 发版时把 `## [Unreleased]` 改成 `## [<版本>] - <YYYY-MM-DD>`，并在最上面补一个新的空 `## [Unreleased]`；
- 已有的历史条目不要改写，只追加。

两个更新记录都在 `files` 白名单里，会随包发布。

先看第 0 节确认该不该发版——这条最容易判断错。

## 0. 什么时候需要升版本

市场对 GitHub 源按**最高 tag** 解析版本，因此「改了东西但没打 tag」在市场看来等于没发版。需要发版的情形：

| 改动 | 是否发版 |
| --- | --- |
| `index.js` / `client.js` / `locale/*.json` / `cordis.patch.yml` 有变化 | 是 |
| 新增或修改了要进包的文件（图标、截图、`screenshots.json`、脚本） | 是 |
| 只有仓库里的 README 措辞变化、且不影响包内其他文件 | 可以只推 `main` |
| 改了 `package.json` 的 `version` 本身 | 是，且必须打 tag；npm 上也要有同名版本 |

版本号按语义走：修 bug 抬 patch（`1.1.3 → 1.1.4`），加配置项/行为变化抬 minor（`1.1.4 → 1.2.0`）。

## 1. 改版本号，并检查 `files` 白名单

```bash
cd /Users/suzhanfeng/demo/dsh-follow-up-prompts
```

`package.json` 里两处一起看：

```bash
python3 -c "import json;d=json.load(open('package.json'));print(d['version']);print(d['files'])"
```

- `version` 改成目标版本；
- `files` 是**白名单**，不列进去的文件不会进 tarball。新增素材（如 `assets/`、`screenshots.json`）必须同时加进 `files`，否则装出来的包里 README 的图是断的——1.1.4 就是为此发版的：`assets/` 当时不在白名单里。

## 2. 自检

```bash
npm run selftest    # 13 个假宿主用例，应全部通过
npm run canary      # 只读扫描会话日志，确认写入的事件不会让会话打不开
```

`selftest` 必须全绿再往下走；`canary` 输出末尾应有一句「未发现会让会话打不开的事件」。

## 3. 打包并核对内容

```bash
rm -f dsh-follow-up-prompts-<版本>.tgz
npm pack
tar -tzf dsh-follow-up-prompts-<版本>.tgz
```

确认关键文件都在：`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`docs/`、`icon.svg`，以及本次新增的素材。

记下大小和 sha256，第 9 节要用：

```bash
stat -f%z dsh-follow-up-prompts-<版本>.tgz        # macOS；Linux 用 stat -c%s
shasum -a 256 dsh-follow-up-prompts-<版本>.tgz    # Linux 用 sha256sum
```

> `.gitignore` 里是 `*.tgz`，打包产物不入库，别 `git add`。

## 4. 提交

一个版本一个提交，标题写清「做什么」，不要只写版本号：

```bash
git add -A
git commit -m "1.1.4: ship the storefront assets in the package"
```

提交信息里的版本号要和 `package.json` 一致，方便事后对账。

## 5. 打 tag

```bash
git tag -a v<版本> -m "<版本>: <一句话说明>"
```

必须是**附注 tag**（`-a`），且 tag 名带 `v` 前缀、与 `package.json` 的版本一致。这一步不要漏：市场、`latest/download` 之外的版本判定都靠它。

## 6. 推送

```bash
git push origin main
git push origin v<版本>
```

国内网络到 GitHub 经常 `Empty reply from server` / `Proxy CONNECT aborted` / `SSL connection timeout`，属正常抖动。用重试循环，别改配置：

```bash
for i in 1 2 3 4; do
  git push -q origin main && git push -q origin v<版本> && { echo "pushed on attempt $i"; break; }
  echo "attempt $i failed"; sleep 4
done
```

推完确认远端 tag 存在，再建 Release（Release 指向不存在的 tag 会失败）：

```bash
git ls-remote --tags origin | grep "v<版本>$"
```

## 7. 建 Release

本机没有 `gh` CLI，也没有 `GITHUB_TOKEN`，凭证在 `~/.git-credentials`（`github.com`，用户 `susirsusir`）。取出来用，**不要打印、不要提交**：

```bash
TOK=$(python3 -c "
import re,os
for line in open(os.path.expanduser('~/.git-credentials')):
    m=re.match(r'https://([^:]+):([^@]+)@github\.com',line.strip())
    if m: print(m.group(2)); break
")
```

```bash
cat > /tmp/rel.json <<'JSON'
{
  "tag_name": "v<版本>",
  "name": "<版本> — <标题>",
  "body": "- 变化一\n- 变化二\n\n升级只需重启。",
  "draft": false,
  "prerelease": false
}
JSON

curl -sS -X POST -H "Authorization: token $TOK" -H "Accept: application/vnd.github+json" \
  -d @/tmp/rel.json \
  https://api.github.com/repos/susirsusir/dsh-follow-up-prompts/releases
```

把返回的 `id` 记下来。发行说明里写「相对上一个版本」的差异；纯打包变化就明说「只有打包变化，`index.js` 未改」，别把小版本说成大功能。

## 8. 上传资产

资产名**必须是 `dsh-follow-up-prompts.tgz`，不带版本号**。因为市场条目引用的是 `releases/latest/download/dsh-follow-up-prompts.tgz`——`latest/download/` 只解析 `latest` 那个 tag，文件名按字面取。带版本号的话，下次发版这个 URL 立刻 404。

```bash
REL=<上一步的 id>
curl -sS -X POST -H "Authorization: token $TOK" -H "Content-Type: application/gzip" \
  --data-binary @dsh-follow-up-prompts-<版本>.tgz \
  "https://uploads.github.com/repos/susirsusir/dsh-follow-up-prompts/releases/$REL/assets?name=dsh-follow-up-prompts.tgz"
```

返回里应是 `"name": "dsh-follow-up-prompts.tgz"`、`"state": "uploaded"`、`"size"` 与本地一致。

## 9. 验证

三件事都对上才算发完：

```bash
# 1) 下载地址活着，且是刚发的那份
curl -sSL -o /tmp/dl.tgz -w '%{http_code} %{size_download}\n' \
  https://github.com/susirsusir/dsh-follow-up-prompts/releases/latest/download/dsh-follow-up-prompts.tgz
shasum -a 256 /tmp/dl.tgz | cut -c1-24

# 2) 包里的版本号是对的
tar -xzOf /tmp/dl.tgz package/package.json | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"

# 3) 远端 tag 在了
git ls-remote --tags origin | grep "v<版本>$"
```

sha256 前缀与第 3 节记下的一致、包内 `version` 等于目标版本，即可。

## 10. npm

包已发布为 [`dsh-follow-up-prompts`](https://www.npmjs.com/package/dsh-follow-up-prompts)（账号 `susirsusir`）。用户可以用 `plugin_manager install_bundle target=dsh-follow-up-prompts` 按包名安装，所以 **GitHub 发版后要同步发 npm**，否则按包名装到的是旧版本。

```bash
npm whoami                      # 应为 susirsusir
npm publish                     # 读 package.json 的 version，无需再指定
```

顺序很关键：`npm publish` 必须在第 1 节改完 `files` **之后**。第 3 节用 `npm pack` 打的就是要发布的那份内容，发布前用下面这句核对一遍再发：

```bash
npm publish --dry-run           # 列出将进包的文件，确认 assets/ 之类都在
```

发布后验证线上拿到的确实是这份：

```bash
npm view dsh-follow-up-prompts version dist.tarball
cd /tmp && npm pack dsh-follow-up-prompts@<版本> && tar -tzf dsh-follow-up-prompts-<版本>.tgz
```

`npm view` 的 `version` 等于目标版本、且 tarball 里有新素材，才算发完。

> 已发出去的版本不能再改：`npm unpublish` 有 72 小时限制，而且会让装过的人下次安装失败。发现包内容不对就抬版本重发。

## 11. 市场侧

- **不需要改 PR**。`awesome-dsh-plugin` 里那一条（`data/plugins/susirsusir__dsh-follow-up-prompts.yml`）的 `tarball:` 指向 `latest/download`，发版即自动切到新包；只有 `icon:` 指向 `raw.githubusercontent.com/.../main/...` 时才依赖 `main`，不依赖 tag。
- 目录索引每天约 **06:23 UTC** 重建一次，卡片版本号在之后一次构建才变。当天发版当天看不到新版本号是正常的。
- 如果改了截图，只需要推自己的 `main`（市场从仓库根目录的 `screenshots.json` 读图），同样等下一次构建。
- 首次收录/新增条目才需要往 `awesome-dsh-plugin` 提 PR；发新版本不用。

## 12. 踩过的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 市场卡片版本号不动 | 没打 tag，或打了没推 | `git push origin v<版本>` |
| 装完 README 里截图是断的 | `files` 白名单漏了 `assets/` | 补 `files` 后重新发版（1.1.4 的由来） |
| 下次发版后下载 404 | 资产名带了版本号 | 改回 `dsh-follow-up-prompts.tgz` |
| `git push` 反复失败 | 到 GitHub 的网络抖动 | 重试循环，别改远端配置 |
| 上传资产 404 | Release 建在还没推上去的 tag 上 | 先推 tag，再建 Release |
| 列表里图标不显示 | 用了 SVG 或第三方图床 | 换成 GitHub 托管的 PNG/JPG/WEBP |
| `install_bundle target=dsh-follow-up-prompts` 装到旧版本 | 只发了 GitHub、没 `npm publish` | 补发 npm；npm 版本号必须与 tag 一致 |
| `npm view` 显示新版本，`npm pack` 仍报 `ETARGET` | 本地 packument 缓存没刷新 | `npm pack <包名>@<版本> --prefer-online` |
| npm 上的包缺 `assets/` | 先 publish 才补 `files` 白名单（1.1.4 就是这样） | 抬版本重发，别试图改已发布的包 |