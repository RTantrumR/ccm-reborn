import { getCurrentWindow } from "@tauri-apps/api/window";

// On Windows the app draws its own title bar (tauri.windows.conf.json turns the system
// one off), so the sidebar and the page run to the top of the window. This is a
// transparent strip to drag the window by (double-click maximizes) and the three
// window buttons. It lives outside #app, which render() rebuilds, so it is made once.

const ICONS = {
  minimize: '<path d="M1 5.5h9"/>',
  maximize: '<rect x="1.5" y="1.5" width="8" height="8"/>',
  restore: '<path d="M3.5 3.5V1.5h7v7h-2"/><rect x="1.5" y="3.5" width="7" height="7"/>',
  close: '<path d="M1.5 1.5l8 8M9.5 1.5l-8 8"/>',
};
const icon = (paths: string) =>
  `<svg viewBox="0 0 11 11" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${paths}</svg>`;

export function mountWindowControls() {
  if (!navigator.userAgent.includes("Windows")) return;
  const appWindow = getCurrentWindow();
  document.body.classList.add("custom-titlebar");
  const bar = document.createElement("div");
  bar.className = "titlebar";
  bar.setAttribute("data-tauri-drag-region", "");
  bar.innerHTML = `<div class="window-controls">
    <button type="button" data-window="minimize" aria-label="Minimize">${icon(ICONS.minimize)}</button>
    <button type="button" data-window="maximize" aria-label="Maximize">${icon(ICONS.maximize)}</button>
    <button type="button" data-window="close" aria-label="Close">${icon(ICONS.close)}</button>
  </div>`;
  document.body.prepend(bar);
  const maximize = bar.querySelector<HTMLButtonElement>("[data-window='maximize']")!;
  bar.querySelector("[data-window='minimize']")!.addEventListener("click", () => void appWindow.minimize());
  maximize.addEventListener("click", () => void appWindow.toggleMaximize());
  bar.querySelector("[data-window='close']")!.addEventListener("click", () => void appWindow.close());
  const showState = async () => {
    const maximized = await appWindow.isMaximized();
    maximize.innerHTML = icon(maximized ? ICONS.restore : ICONS.maximize);
    maximize.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  };
  void appWindow.onResized(() => void showState());
  void showState();
}
