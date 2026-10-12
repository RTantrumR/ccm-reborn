# Building CCM Reborn

## Stack
- **App**: [Tauri 2](https://tauri.app/): a Rust backend with a vanilla TypeScript frontend (Vite).
- **Rust core**: install, switching, backups and save handling live in `src-tauri/src/legacy/`.
  The same core drives the app and the `ccm` command-line tool.
- **Library**: read from the Campaign Archive feed (`src/archive.ts`).

## Prerequisites
- Node.js 20 or newer
- Rust (stable, via [rustup](https://rustup.rs/))
- Tauri's [system prerequisites](https://tauri.app/start/prerequisites/) for your OS
  (on Windows: the MSVC C++ build tools and WebView2)

## Run it
```sh
npm ci
npm run tauri dev        # the real app, with a hot-reloading frontend
```
`npm run dev` alone serves only the frontend; every call into Rust fails outside Tauri.

Use a spare StarCraft II install, or back up your `Documents\StarCraft II` folder, before you
try installs and switches during development.

To point a dev build at a local Campaign Archive feed, set
`VITE_ARCHIVE_FEED=http://127.0.0.1:8791`.

## Checks
These run in CI on Windows, macOS and Linux for every push and pull request:
```sh
npm run check:source-size   # no source file over 500 lines
npm run build               # type check + frontend build
npm test                    # frontend tests (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml
```

## Installers
```sh
npm run tauri:win            # Windows NSIS setup.exe
npm run tauri:mac:universal  # macOS .dmg for Apple Silicon and Intel (on a Mac)
npm run tauri:linux          # .deb and AppImage (Linux, or macOS with Docker)
```
Output lands in `src-tauri/target/**/release/bundle/`. The `Makefile` mirrors these.

## Releases
The **Release** workflow builds all three platforms and attaches them to a GitHub Release.
```sh
npm run version:bump -- 1.0.1   # updates the Node, Rust and Tauri manifests together
git commit -am "chore: version 1.0.1"
git tag v1.0.1
git push origin main v1.0.1
```
The tag has to match the manifests' version. A version with a suffix (`1.1.0-beta.1`) is
published as a pre-release.

## Mod package format
The app installs the original CCM's ZIP layout. A package has one `metadata.txt`; its
`campaign=` value picks the folder it goes into:

| `campaign=` | Game folder |
| --- | --- |
| Wings / Liberty / WoL | `Maps/Campaign` |
| Heart / Swarm / HotS | `Maps/Campaign/swarm` |
| Legacy / Void / LotV | `Maps/Campaign/void` |
| Nova / Covert / NCO | `Maps/Campaign/nova` |

Installing a Wings of Liberty mod leaves the `swarm`, `void` and `nova` folders alone. Each
install records exactly which files it copied (`<game>/.ccm-reborn/installed/`), so a later
switch only removes what it put there.

## Command line
```sh
cargo run --manifest-path src-tauri/Cargo.toml --bin ccm -- help
```
Everything is read-only except `install` and `restore`, which need a typed confirmation.

## Project structure
- `src/`: frontend, one module per page or dialog (`main.ts`, `my-mods.ts`, `render-library.ts`, …).
- `src/styles/`: stylesheets; every colour and size comes from `tokens.css`.
- `src-tauri/src/legacy/`: the Rust core, split into numbered parts with their tests.
- `src-tauri/src/bin/ccm.rs`: the command-line tool.
- `scripts/`: build, release and version scripts.
- `catalog/`, `dev-catalog/`, `scripts/discord/`, `scripts/hygraph/`, `skills/`, `docs/cms/`:
  the original project's catalogue tooling, not used by this fork's app.
