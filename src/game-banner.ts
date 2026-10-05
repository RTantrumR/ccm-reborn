// The one place that says StarCraft II (or the player's account) is missing,
// shown in the sticky page header on every page. Dismissing a message lasts for
// this session: the player has seen it and wants to browse for now. A different
// message (the account, once the game is found) still shows.
let dismissed = "";

// Sticky panels below the header (the Library detail pane) offset themselves
// by --header-h. render() replaces #app's children, so re-measure on each one.
function syncHeaderHeight() {
  const height = document.querySelector("main > header")?.getBoundingClientRect().height ?? 0;
  document.documentElement.style.setProperty("--header-h", `${height}px`);
}

const app = document.querySelector("#app");
if (app) new MutationObserver(syncHeaderHeight).observe(app, { childList: true });
window.addEventListener("resize", syncHeaderHeight);

document.addEventListener("click", (event) => {
  const close = (event.target as Element | null)?.closest<HTMLElement>("[data-action='dismiss-game-banner']");
  if (!close) return;
  dismissed = close.dataset.banner ?? "";
  close.closest(".game-banner")?.remove();
  syncHeaderHeight();
});

/// Installs need both the game folder and the player's account folder (that is
/// where saves and campaign progress live), so the banner names whichever is missing.
export function renderGameBanner(gameDir: string, profileDir: string) {
  if (gameDir && profileDir) return "";
  const [text, action, label] = !gameDir
    ? ["StarCraft II wasn't found. Choose its folder to install campaigns.", "choose-directory", "Choose folder…"]
    : ["Your StarCraft II account wasn't found. Choose it so your progress stays with the right account.", "choose-profile", "Choose account…"];
  if (dismissed === action) return "";
  return `<div class="game-banner" role="status">
    <p>${text}</p>
    <button class="ghost compact" data-action="${action}">${label}</button>
    <button class="banner-close" data-action="dismiss-game-banner" data-banner="${action}" aria-label="Dismiss">×</button>
  </div>`;
}
