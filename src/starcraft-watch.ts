import { invoke } from "@tauri-apps/api/core";

// Play is pointless while the game already runs, and pressing it again only nudges
// Battle.net. The app checks every few seconds while it is on screen.
let running = false;
let launchingUntil = 0;
const LAUNCH_GRACE_MS = 60_000;

export const starcraftRunning = () => running;
// Between pressing Play and the game's process appearing.
export const starcraftLaunching = () => !running && Date.now() < launchingUntil;

export function noteLaunched() {
  launchingUntil = Date.now() + LAUNCH_GRACE_MS;
}

export function playButtonLabel() {
  return running ? "StarCraft II is running" : starcraftLaunching() ? "Starting StarCraft II…" : "Play StarCraft II";
}

/// Updates the Play button in place: a full render() would reset scroll and close an
/// open dropdown each time the game starts or stops.
function syncPlayButton(busy: boolean) {
  const button = document.querySelector<HTMLButtonElement>("[data-action='play-sc2']");
  if (!button) return;
  button.disabled = busy || running || starcraftLaunching();
  button.textContent = playButtonLabel();
}

export function watchStarcraft(isBusy: () => boolean) {
  const check = async () => {
    if (document.visibilityState !== "visible") return;
    try {
      running = await invoke<boolean>("starcraft_is_running");
    } catch {
      running = false;
    }
    syncPlayButton(isBusy());
  };
  void check();
  window.setInterval(() => void check(), 4000);
  window.addEventListener("focus", () => void check());
}
