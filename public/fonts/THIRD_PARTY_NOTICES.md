# Bundled font notices

The desktop application bundles the following font files. They are grouped by
license:

1. **SIL Open Font License 1.1** — freely redistributable, commercial use
   included. License texts live in [`licenses/`](licenses/).
2. **Publisher's own free-for-commercial-use terms** — released by their
   publishers for free use including commercial use, so they may be bundled;
   see the notes on license texts below.

---

## 1. SIL Open Font License 1.1

### Inter 4.001

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter).

Official source: [Google Fonts download manifest](https://fonts.google.com/download/list?family=Inter)

- `Inter-VariableFont_opsz,wght.ttf` — SHA-256 `0be2399ea925f1f83ff974764761da9860ec50742ed29a5d4c1ffd0c5c7ac3a8`
- `Inter-Italic-VariableFont_opsz,wght.ttf` — SHA-256 `6136f73372fedc37b80fd1a8ec3e21734073ff17376f3672718f186779672e7a`
- License: [`licenses/Inter-OFL-1.1.txt`](licenses/Inter-OFL-1.1.txt)

### LXGW WenKai 1.522

Copyright 2021-2026 LXGW (https://github.com/lxgw/LxgwWenKai), with the
Reserved Font Names and additional permission stated in the accompanying
license. Copyright 2020 The Klee Project Authors
(https://github.com/fontworks-fonts/Klee).

Official source: [LXGW WenKai commit `50f4b182415a8c33d9a456df220b66a284e2509b`](https://github.com/lxgw/LxgwWenKai/tree/50f4b182415a8c33d9a456df220b66a284e2509b)

- `LXGWWenKai-Regular.ttf` — SHA-256 `39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009`
- `LXGWWenKai-Medium.ttf` — SHA-256 `d4bdeb38a39151d74d084cba5090f8cb7d20bf83eedb78c35939ae70b9f4e3f6`
- License and additional permission: [`licenses/LXGWWenKai-OFL-1.1.txt`](licenses/LXGWWenKai-OFL-1.1.txt)

### Noto Sans SC 2.004-H2

Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name
"Source".

Official source: [Google Fonts download manifest](https://fonts.google.com/download/list?family=Noto%20Sans%20SC)

- `NotoSansSC-VariableFont_wght.ttf` — SHA-256 `e80613a35583f59b46dbf6cc2eb640f3db0bb0f53fa7f6fbaa7b09faf20e5172`
- License: [`licenses/NotoSansSC-OFL-1.1.txt`](licenses/NotoSansSC-OFL-1.1.txt)

### Noto Serif SC 2.003-H1

Copyright 2012 Google Inc. All Rights Reserved.

Official source: [Google Fonts download manifest](https://fonts.google.com/download/list?family=Noto%20Serif%20SC)

- `NotoSerifSC-VariableFont_wght.ttf` — SHA-256 `e553aa4a7eb6e45ba39d7a562ef4b51ac5764d21ce9ea12995f264a9b3e63cd7`
- License: [`licenses/NotoSerifSC-OFL-1.1.txt`](licenses/NotoSerifSC-OFL-1.1.txt)

---

## 2. Free-for-commercial-use fonts (publisher's own terms)

> **TODO before a public release.** 这两款字库由各自的发布方声明「免费商用」
> （可再分发），因此随软件打包。它们的**许可原文尚未收进 `licenses/`** ——
> 公开发布前应把发布方的原始授权说明补到本目录，或在应用内「关于」页附上链接。

### Chosunilbo Myeongjo（朝鲜日报明朝体）

Copyright The Chosun Ilbo (조선일보). Released by the publisher for free use,
commercial use included.

Source: supplied by the project owner (`ziti/ChaoXianRiBaoMingChaoTi.zip`);
originally published by The Chosun Ilbo. Also catalogued at
<https://www.zikuxq.com/font/11344.html>.

- `ChosunilboMyeongjo.ttf` — 22,965,244 bytes — SHA-256 `6a557707b7ec3ff52b393e7e15576013f7ea2ac3dd0a600d9cbbad14aacfef6c`
- Chinese coverage: GB2312 6763 / 6768 hanzi (99.9%)
- CSS family alias: `Chosunilbo Myeongjo` (the font's internal family name is `ChosunilboNM`)

---

## 3. Note: a bundled font that no style references

### YiShanBeiZhuanTi.ttf（峄山碑篆体）

- Path: `public/fonts/YiShanBeiZhuanTi.ttf` — 2,260 KB
- `shell.css` registers it via `@font-face { font-family: 'YiShanZhuan' }`, but
  **no style in the codebase references `YiShanZhuan`** — the seal-script stack
  (`--zhuan`) lists other families instead. Verified 2026-09-15: the identifier
  appears only in that one `@font-face` line. The file is unused at runtime.
- Kept in the repository as-is, per the project owner's call on 2026-09-15.
