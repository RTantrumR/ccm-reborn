// The app runs inside a browser engine (WebView2 on Windows), which keeps a browser's own
// keys and right-click menu: reload, find, print, save page, view source, developer tools,
// zoom, back/forward. None of them belong in the app, and a reload or a back step would
// drop whatever it was doing. They are swallowed here, before the engine acts on them.
// Editing keys (Ctrl+C/V/X/A/Z), the app's own keys (Esc, Enter, arrows) and the system's
// (Alt+F4, Alt+Tab) still work.

// F3 find next, F5 reload, F7 caret browsing, F12 developer tools. Other F-keys do nothing here.
const BROWSER_F_KEYS = new Set(["F3", "F5", "F7", "F12"]);
const CTRL_KEYS = new Set(["r", "f", "g", "p", "s", "u", "o", "+", "=", "-", "0"]);
const CTRL_SHIFT_KEYS = new Set(["i", "j", "c", "r"]);
const BROWSER_KEYS = new Set(["BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserSearch", "BrowserHome"]);

function isBrowserShortcut(event: KeyboardEvent) {
  if (BROWSER_KEYS.has(event.key)) return true;
  // Alt+F4 closes the window; nothing with Alt held is an F-key browser command.
  if (BROWSER_F_KEYS.has(event.key)) return !event.altKey;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (command && event.shiftKey && CTRL_SHIFT_KEYS.has(key)) return true;
  if (command && !event.altKey && CTRL_KEYS.has(key)) return true;
  return event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
}

export function blockBrowserControls() {
  window.addEventListener("keydown", (event) => {
    if (!isBrowserShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
  window.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });
  // The mouse's back/forward buttons.
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  }, { capture: true });
}
