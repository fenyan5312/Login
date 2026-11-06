# AGENTS.md — 本仓库的工作约定

适用于所有在本仓库工作的 agent 与自动化。规则短，但要执行。

## 分支与合并

- 任何改动都从最新 `main` 开分支，名字用 `cindy-default/<topic>`；一个分支只做一件事。
- 禁止 agent 直接 commit/push 到 `main`。改动一律提 PR。
- PR 合并由初号机执行；合并后必须重跑 CI，绿了才算完成。
- 提交前跑完整 `bun test`；不要只跑改到的文件就宣布通过。

## 目录 ownership（建议，不是硬门禁）

- `proxy-*` 归“代理线”：`lib/proxy-*.mjs`、`ui/proxy-*`、`test/proxy-*`、页面里的代理区块。
- `signin-*` 归“登录线”：`lib/signin-*.mjs`、`ui/signin-*`、`test/signin-*`、登录对话框。
- 目的是减少并行 agent 撞同一个文件；跨线改动先在 PR 里说明，不要顺手重排无关文件。

## 禁区

- 不读写真实 `~/.config/magpie/`（生产数据）；不碰用户已安装的插件数据。
- 所有测试必须用 tmpdir，并通过 `MAGPIE_CONFIG_DIR`、`MAGPIE_CLEAN_LOGIN_DATA` 等环境变量指到临时目录。
- 不重启、不杀掉生产 magpie 实例。
- 不为了让 CI 变绿而删断言、放宽断言、改成永远 skip，或用 `|| true` 掩盖失败。
  skip 只允许用于明确、可解释的环境缺失，并在测试名/输出里写明原因。

## 测试纪律

- 新功能、修 bug 必须带测试；修 bug 的测试要能复现原问题。
- 测试不写仓库、不写用户目录，运行完自行清理临时目录。
- 改动 `lib/`、`ui/`、`page/` 或 `index.mjs` 时，必须 bump `package.json` 的 `version`。
  否则 `scripts/check-version-bump.mjs` 会让 CI 失败。本地可先跑：
  `bun scripts/check-version-bump.mjs --base origin/main`

## 发布纪律

- magpie 判断插件有没有新版本，比的是 `package.json` 的 `version` 字符串；不 bump 版本，用户端就看不到这次更新。
- 发布 = bump version + 打 tag `vX.Y.Z`，用一条命令完成：
  `bun scripts/release.mjs --patch`（或 `--minor`、显式 `X.Y.Z`）
- 默认不 push；确认后加 `--push`。先 `--dry-run` 预览。
- 不要自动写 CHANGELOG；发布提交只包含 `package.json` 的版本变更。
