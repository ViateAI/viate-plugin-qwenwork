# Third-party notices

The login, catalog, and chat translation are adapted from the MIT code in:

- https://github.com/tianyn1990/qwenwork-magpie (v0.1.0)
- https://github.com/ErkundenSie/pi-qwenwork-provider
- https://github.com/jianhx189/qwenwork2api

`src/wasm.ts` adapts the wasm-bindgen glue from https://github.com/XuePengJu/dsh-our-free-model (`vendor/channel-pack/src/qwenwork-wasm.ts`, MIT, Copyright (c) 2026 Jet).

`vendor/qoder-auth-wasm/qoder_auth_wasm_bg.wasm` is the official signer extracted from the QwenWorkCN Linux package at `https://assets.qwenwork.cn/release/latest/qwenworkcn-linux-amd64.deb`.

- Path in the package: `opt/apps/QwenWorkCN/resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`
- Size: 288929 bytes
- SHA-256: `15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3`

That hash matches the signer shipped with the 2.1.0 desktop component used by the MIT adapters. The Linux package's `app.asar` reported `2.0.2` / `2.0.2-26111601`. Requests advertise `2.1.0` / `2.1.0-26111906` unless `QWENWORK_CLIENT_VERSION` and `QWENWORK_RELEASE_VERSION` override them.

The wasm binary is not covered by this repository's MIT license. Rights stay with the original owner. The plugin does not read the desktop app's login files.
