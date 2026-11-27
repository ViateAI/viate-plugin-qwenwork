# @viateai/plugin-qwenwork

Viate provider for a personal [千问办公](https://qwenwork.cn) account. It uses the browser device login from the Linux.do thread [求千问办公反代](https://linux.do/t/topic/3166912). No API key, and it does not read the desktop app's login files.

Chat requests are signed with the official `qoder_auth_wasm_bg.wasm` and sent to `gateway.qwenwork.cn`. The plugin speaks OpenAI chat completions. Streaming, tools, and `reasoning_content` are passed through.

## Login

In the admin console, add a `qwenwork` connection and choose 浏览器授权. Open the link and confirm in the browser. The page does not ask for the displayed code (`无需验证码`); the console polls until the login finishes.

导入登录态 accepts JSON with `access`, `refresh`, `uid`, and `machineId`. That is a bundle this plugin already produced, not a file copied out of the desktop app.

## Models

`qwork-auto` and `qwork-advanced` are the 标准 and 高级 tiers. When the account catalog says so, they are sent upstream as `flash` and `pro`. Named models (`qwen3.8-flash`, `glm-5.3`, …) use their own ids. A live catalog replaces the built-in list; if that request fails, the built-in list stays available.

Which models a plan can call is decided by 千问办公. This plugin does not bypass that.

## Install

This package is not published to npm. Clone the repository, compile it, and install that directory. `viate.entry` is `dist/index.js`, and `dist/` is not in git. The installer runs with `ignore-scripts=true`, so it will not compile the package for you.

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
git clone https://github.com/ViateAI/viate-plugin-qwenwork.git
cd viate-plugin-qwenwork
pnpm install
pnpm build
viate plugin add "$PWD"
```

`$PWD` is passed to `pnpm add` by the `viate` process. From the admin plugin source field, use the same directory as an absolute path that process can read.

`@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy. `plugin add` stages a pending workspace. Restart the gateway to load it.

To install a newer checkout, pull, run `pnpm install` and `pnpm build` again, then `viate plugin add "$PWD"` again, and restart.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Override the signer or the advertised client version with `QWENWORK_WASM_PATH`, `QWENWORK_CLIENT_VERSION`, and `QWENWORK_RELEASE_VERSION`.

The wasm file is extracted from the official Linux package and is not covered by this repository's MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Release Please on `main` owns the version and changelog. Do not edit either by hand.

MIT. See [LICENSE](LICENSE).
