// The one place that says StarCraft II is missing, shown in the sticky page
// header on every page. Dismissing it lasts for this session: the player has
// seen it and wants to browse for now.
let dismissed = false;

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
  const close = (event.target as Element | null)?.closest("[data-action='dismiss-game-banner']");
  if (!close) return;
  dismissed = true;
  close.closest(".game-banner")?.remove();
  syncHeaderHeight();
});

export function renderGameBanner(gameDir: string) {
  if (gameDir || dismissed) return "";
  return `<div class="game-banner" role="status">
    <p>StarCraft II wasn't found. Choose its folder to install campaigns.</p>
    <button class="ghost compact" data-action="choose-directory">Choose folder…</button>
    <button class="banner-close" data-action="dismiss-game-banner" aria-label="Dismiss">×</button>
  </div>`;
}
