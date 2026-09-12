# Attributions

OpenFont Manager is built on other people's work.

## Font sources

### Google Fonts

<https://github.com/google/fonts>
Licences: SIL Open Font License 1.1, Apache License 2.0, Ubuntu Font Licence 1.0 — per family, in each family's directory.

The catalogue is built from `fonts.google.com/metadata/fonts` and the repository tree; the files are fetched from the repository at runtime, mirrored by jsDelivr. Previews use the Google Fonts CSS API.

### Fontsource

<https://fontsource.org>
Licence of the project: MIT. Fonts carry their own licences, recorded per family.

The ~120 families Google Fonts does not carry, served by jsDelivr.

## Code

### pptx-font-manager

<https://github.com/stoatworks-labs/pptx-font-manager> — MIT, Stoatworks Labs

The font-install code (`src-tauri/src/fonts.rs`), the name normaliser (`src/core/names.ts`), the installer scripts (`src/core/installers.ts`) and the substitutes table were carried over from this sibling project.

### Tauri

<https://tauri.app> — MIT or Apache-2.0, The Tauri Programme within The Commons Conservancy

### React

<https://react.dev> — MIT, Meta Platforms, Inc. and affiliates

### fflate

<https://github.com/101arrowz/fflate> — MIT, Arjun Barrett

The zip is streamed through fflate's `Zip` class.

### The npm and crates.io ecosystems

The full transitive dependency set for any build is pinned in `package-lock.json` and `src-tauri/Cargo.lock`, which are the authoritative lists.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
