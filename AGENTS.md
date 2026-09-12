# AGENTS.md — OpenFont Manager

What a model working on this repo needs to know that the code does not say
by itself. Commands are in [CLAUDE.md](CLAUDE.md).

## 1. What this is

A browser tool (Vite + React, `src/`) and a Tauri desktop app around the same
UI (`src-tauri/`). The browser half browses two catalogues, previews,
downloads a streamed zip and imports/exports lists. The desktop half adds
what a page cannot do: install into the OS font folder, start at login,
watch a folder, read a share. The desktop half also runs headless
(`--sync`, `--install`), which is why the Rust side carries its own copy of
the catalogue and list parser rather than asking the webview.

Sibling: `pptx-font-manager` (same author). The font-install code, name
normalisation, installer scripts and substitutes table came from there and
should stay recognisably the same; a fix in one belongs in the other.

## 2. Downloads come from the repo files, never the CSS API

`fonts.googleapis.com/css2` serves **woff2**, **subsetted by unicode-range**,
to any browser UA, and a browser cannot change its UA on `fetch`. A
subsetted woff2 installs without complaint and renders blanks outside its
subset. So font *files* come from `raw.githubusercontent.com/google/fonts`
(complete original TTFs, CORS `*`), mirrored by `cdn.jsdelivr.net/gh` for
when GitHub rate-limits a bulk pull. The CSS API is used for one thing: the
preview line on each card, where a small subsetted woff2 is exactly right.

## 3. Fontsource TTFs are subsetted too

Fontsource's docs say its TTFs bundle every subset. They do not:
`{subset}-{weight}-{style}.ttf` is all there is. The catalogue therefore
keeps only families declaring exactly one subset (their one file is the
whole font), and `scripts/build-fontsource-catalogue.mjs` enforces it. It
also drops anything Google already has, so `findFamily` never has to choose.

## 4. The catalogue is baked, twice

`src/data/*.json` are build-time snapshots — the Google metadata endpoint
has no CORS header. The frontend imports them; the Rust crate `include_str!`s
the same files (`src-tauri/src/catalogue.rs`), so the two sides can never
disagree about what exists, but a regenerated catalogue needs a desktop
rebuild to reach the sync pass.

Name matching is the same rule on both sides: `normalizeKey` (case,
punctuation) then a trailing-style strip (`Poppins SemiBold Italic` ->
`poppins`), conservative enough that families called `Black` and `Medium`
still resolve. The Rust `strip_style` requires a word boundary so `bookman`
keeps its `book`.

## 5. A sync pass is additive and idempotent

- A file already in the font folder under the same name is skipped, never
  overwritten. On Windows an in-use font cannot be replaced anyway.
- Nothing is ever removed. A sync that deletes fonts is a sync that one day
  empties a laptop before a show.
- A list is remembered in `state.json` by sha256 of its content, and only
  once every file it named came down cleanly — a failed download leaves it
  unremembered so the next pass retries. Unresolvable names do not block
  remembering (they would otherwise be retried forever for nothing, though
  retrying is cheap since nothing is downloaded twice).
- Fonts on a share are compared by filename against the font folder. Ship
  a new version under a new filename.
- `._*` and dotfiles are skipped: macOS leaves AppleDouble `._Foo.ttf` on
  SMB shares and they are not fonts.

Every byte written into a font folder passes `is_sfnt` (TrueType/OpenType/
collection signature) and `safe_filename` (no path, font extension) first.
A 404 page with a 200 status must never land under a font's name. The same
two checks live in `src/core/fetch.ts` for the browser zip.

## 6. Tauri traps

- **A plain `cargo build` produces a binary that loads `devUrl`**, i.e. the
  vite dev server on port 5189, and shows a blank window if nothing is
  there. Use `npx tauri build --debug --no-bundle` to get a debug binary
  with `dist/` embedded — that is what the end-to-end checks used.
- `dragDropEnabled: false` on the window is deliberate: with Tauri's native
  drag-drop on, HTML5 file drops (the list importer) never reach the page.
- Cmd+Q / the Dock's Quit **hides to the tray** (`RunEvent::ExitRequested`
  with `code: None` is prevented). Only the tray's own Quit exits. A user who
  wants the app gone must use the tray.
- The tray menu's *Sync now* runs on a spawned thread; commands that block
  (`sync_now`, `install_plan`, `save_plan`, `probe_source`,
  `installed_families`) are `async` and use `spawn_blocking`. The folder
  picker uses the callback API and a channel — the blocking picker must not
  run on the main thread on macOS.
- `tauri-plugin-autostart` registers the running binary's path with
  `--background`. Enabling it from a debug build registers the debug build.
- Driving the WKWebView from scripts: raw clicks do not reach buttons, but
  System Events walking `entire contents of window 1` for `button` by name
  works; `screencapture -l <CGWindowID>` captures the window.
- `register: false` in `provision::Context` exists only for tests. A test
  that installs into a temp directory with `register: true` would register
  that directory's files with the user's font server (CoreText user scope
  persists). The CLI and the app always pass `true`.

## 7. WebDAV

`src-tauri/src/webdav.rs` is a minimal client: PROPFIND `Depth: 1` per
collection, recursing, then GET. Hrefs come back percent-encoded and either
as absolute paths (Nextcloud, Apache) or full URLs (some IIS); both are
handled, and `rel` is computed against the root so a file's folder is known.
Checked against a scratch server with basic auth, a folder name with a space,
and a wrong password (which reports "check the username and password" rather
than a bare 401).

Passwords: keychain on macOS/Windows (`keyring` crate, service
`com.stoatworks.openfontmanager`, account = the source id); on Linux a
`secrets.json` next to the settings at mode 0600, because the desktop
secret-service crates need D-Bus headers at build time and the release
builder does not have them. The UI says which.

## 8. What was and was not verified (v0.1.0, 2026-09-12)

macOS (this machine): browser zip with real downloads (mirror fallback
exercised by a 429); import of every format; desktop cart install into a
scratch folder with CoreText registration (the "installed" badge appeared
immediately); headless `--sync` three passes (list, share font, no-op); the
provisioning panel's Test, Sync now and log; a WebDAV source with basic auth;
`--background` listing no window and running the startup pass, a second
launch forwarded by single-instance and revealing it; the login item writing
`~/Library/LaunchAgents/OpenFont Manager.plist` (`--background`, RunAtLoad).

Windows 11 26200 (win-lab VM, the NSIS installer from the release dry run):
silent `/S` install to `%LOCALAPPDATA%\OpenFont Manager`; headless
`--install` put five files in the per-user font folder and five values in
the HKCU Fonts key named the way the shell names them (`Abel Regular
(TrueType)`); a GUI install of Montserrat took the key from 5 to 7 values —
additive, nothing wiped — and GDI+ enumerated every named instance at once;
the login item wrote the HKCU Run value with `--background` and removed it;
`--background` ran the startup pass with no window. **Window checks from an
ssh session are blind**: it runs in session 0 and `FindWindow` /
`MainWindowTitle` cannot see session 1's windows — the hypervisor's
`virsh screenshot` is the only evidence of what is on screen. Drive the app
through WebView2's CDP (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
--remote-debugging-port=9222`, launched by a scheduled task with an
Interactive principal, tunnelled with `ssh -L`).

Ubuntu 24.04 (kde-lab VM, the .deb): headless `--install` put 19 files in
`~/.local/share/fonts` and `fc-list` saw all of them; the GUI showed the
installed badge from fontconfig, installed Lobster Two from the checkout and
flipped the badge; the login item wrote `~/.config/autostart/OpenFont
Manager.desktop`; `--background` showed only the tray icon and ran the
startup pass. Driven with xdotool on the X11 session.

Not verified: an actual login with the item enabled on any platform; a real
SMB or NFS mount as a source (proved on a local folder and a WebDAV server);
the release installers as signed/notarised artefacts (only the dry-run
artifacts were installed).
