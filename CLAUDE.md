# CLAUDE.md — OpenFont Manager

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 32 tests, offline
npm run build        # tsc -b && vite build -> dist/
npx tsc -b           # typecheck only

npm run desktop:dev                                 # tauri dev
npx tauri build --debug --no-bundle                 # debug binary WITH the site embedded (see AGENTS §6)
npm run desktop:build                               # release installers
cargo test --manifest-path src-tauri/Cargo.toml     # 21 Rust tests, offline
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets   # clean as of v0.1.0; keep it so
```

Headless, against a scratch home and font folder so nothing on this machine
is touched:

```bash
OPENFONT_HOME=/tmp/of-home OPENFONT_INSTALL_DIR=/tmp/of-fonts \
  src-tauri/target/debug/openfont-manager --sync
```

## Regenerating the catalogues

```bash
npm run catalogue        # Google first, then Fontsource (it reads the Google one)
```

`scripts/build-catalogue.mjs` reads `fonts.google.com/metadata/fonts` and the
`google/fonts` repo tree (set `GITHUB_TOKEN` to avoid the 60/hour limit) and
writes `src/data/google-fonts.json`. `scripts/build-fontsource-catalogue.mjs`
writes `src/data/fontsource-fonts.json`. **The Rust side embeds the same two
files** via `include_str!`, so regenerate, then rebuild the desktop app.

## Ground rules

- **`src/core/` must not touch the DOM.** It runs in vitest under `node` and
  the Rust side mirrors it; browser-only code lives in `src/platform/`.
- **Never download from the Google CSS API.** It cannot return an installable
  file. Previews only. See AGENTS.md §2.
- **Never ship a multi-subset Fontsource family.** Its TTFs are subsetted per
  unicode-range; only single-subset families are safe, and the build script
  enforces that. See AGENTS.md §3.
- **A sync pass never overwrites and never deletes.** See AGENTS.md §5.
- **Everything written into a font folder passes `is_sfnt` and
  `safe_filename` first** — in Rust and in `src/core/fetch.ts`.
- **The command names and shapes in `src/platform/native.ts` are the IPC
  contract with `src-tauri/src/lib.rs`.** Change both together.
- **The list parsers in `src/core/lists.ts` and `src-tauri/src/lists.rs` must
  agree.** Both test suites parse `examples/`; add a case to both when the
  format grows.
- **`public/_headers` CSP** must allow `raw.githubusercontent.com` and
  `cdn.jsdelivr.net` in `connect-src` (downloads) and `fonts.googleapis.com`
  / `fonts.gstatic.com` / `cdn.jsdelivr.net` in `style-src` / `font-src`
  (previews). The Tauri CSP in `tauri.conf.json` is the same list plus `ipc:`.
