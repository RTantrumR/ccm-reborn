# CCM Reborn

A desktop app for playing StarCraft II community campaigns. Pick a mod, install it with one click,
and press Play. Each of the four campaigns (Wings of Liberty, Heart of the Swarm, Legacy of the Void,
Nova Covert Ops) holds its own mod, and your saves stay with the mod that made them.

**Beta.** 1.0.0 is this fork's first release. Expect rough edges and please
[report what breaks](https://github.com/RTantrumR/ccm-reborn/issues).

## What it does

- **Library**: the mods shared in the GiantGrantGames Custom Campaign Manager community, with
  pictures, descriptions, patch notes and a link to each mod's Discord thread.
- **One-click install**: the download is checked before anything in the game folder changes, and
  the campaign it replaces is backed up first. A mod that can't be checked yet opens its download
  page instead.
- **My Mods**: one card per campaign. Switch to another mod you installed before, or back to
  Blizzard's original, and the saves of each mod go with it.
- **Play**: starts StarCraft II through Battle.net. If the game is running when you switch a
  mod, the app offers to close it and saves your mission first.
- **Works with the original CCM**: mods it left in your game folder show up in My Mods, and you
  can add a mod from a `.zip` on your computer.

## Install

1. Download the latest release from
   [Releases](https://github.com/RTantrumR/ccm-reborn/releases/latest):
   `setup.exe` for Windows, `.dmg` for macOS, `.deb` or AppImage for Linux.
   Windows may say the publisher is unknown: choose **More info → Run anyway**.
2. Open the app. It finds StarCraft II and your account by itself; if it can't, it asks you to
   choose them.
3. Pick a mod in the **Library**, press **Install**, then **Play**.

Windows is where the app has been tested. The macOS and Linux builds are new: Play only opens
Battle.net there, and the app can't yet tell whether StarCraft II is running, so close the game
yourself before switching a mod.

## Building from source

See [BUILDING.md](BUILDING.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for credits and bundled components.

A fork of [CCM Reborn by umaxfun](https://github.com/umaxfun/ccm-reborn), continued with his blessing.

*StarCraft is a trademark of Blizzard Entertainment, Inc. This is an unofficial fan project.*
