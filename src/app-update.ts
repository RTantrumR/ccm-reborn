import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A newer release of the app, asked once per start (part28_app_update.rs) and from Settings.
// A dialog offers it; after Later, Settings keeps an "Update to …" button. On Windows, Update
// downloads and checks the installer, starts its wizard and the app closes; elsewhere it opens
// the release page.

type AppUpdate = { version: string; pageUrl: string; canInstall: boolean };
type Stage = "ask" | "downloading" | "failed";
type UpdateContext = { render: () => void };

let update: AppUpdate | null = null;
// Later (or a failed try) puts the dialog away; Settings still offers the update.
let dismissed = false;
let stage: Stage = "ask";
let checking = false;
let checkNote = "";
let progress: { downloaded: number; total: number } | null = null;
let problem = "";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

/** At start: offline, or GitHub not answering, says nothing. */
export async function checkForAppUpdate(context: UpdateContext) {
  try {
    update = await invoke<AppUpdate | null>("check_app_update");
  } catch {
    update = null;
  }
  if (update) context.render();
}

async function checkFromSettings(context: UpdateContext) {
  checking = true;
  checkNote = "";
  context.render();
  try {
    update = await invoke<AppUpdate | null>("check_app_update");
    dismissed = false;
    stage = "ask";
    if (!update) checkNote = "You have the newest version.";
  } catch {
    checkNote = "Couldn't check right now. Try again later.";
  }
  checking = false;
  context.render();
}

/** Settings' row: check, or update to a version already found. */
export function appUpdateSetting() {
  const button = update
    ? `<button type="button" class="primary" data-action="settings-app-update">Update to ${escapeHtml(update.version)}</button>`
    : `<button type="button" class="ghost" data-action="check-app-update" ${checking ? "disabled" : ""}>${checking ? "Checking…" : "Check for a new version"}</button>`;
  return `<div class="directory-actions app-update-row">${button}${checkNote ? `<span>${escapeHtml(checkNote)}</span>` : ""}</div>`;
}

const percent = () => progress && progress.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : null;

function progressBar() {
  const value = percent();
  return `<div class="install-progress"><div class="progress-track ${value === null ? "indeterminate" : ""}" aria-label="Download progress"><i style="width: ${value ?? 100}%"></i></div></div>`;
}

/** An install or switch in progress keeps the offer back until it's done. */
export function renderAppUpdateDialog(busy: boolean) {
  if (!update || dismissed || (busy && stage === "ask")) return "";
  const body = stage === "downloading" ? `<p class="dialog-note">Downloading the update…</p>${progressBar()}`
    : stage === "failed" ? `<p class="dialog-note">${escapeHtml(problem)}</p>` : "";
  const actions = stage === "downloading" ? ""
    : stage === "failed"
      ? `<button class="ghost" value="cancel">Close</button><button class="primary" data-action="open-update-page">Open the download page</button>`
      : `<button class="ghost" value="cancel" autofocus>Later</button><button class="primary" data-action="app-update">Update</button>`;
  return `
    <dialog id="app-update-dialog">
      <form method="dialog" class="dialog-card">
        <div><p class="eyebrow">UPDATE</p><h2>Version ${escapeHtml(update.version)} is out</h2></div>
        ${body}
        ${actions ? `<div class="dialog-actions">${actions}</div>` : ""}
      </form>
    </dialog>`;
}

// Progress moves the bar in place: a full render per event would rebuild the dialog.
function paintProgress() {
  const value = percent();
  const track = document.querySelector<HTMLElement>("#app-update-dialog .progress-track");
  const bar = track?.querySelector<HTMLElement>("i");
  if (!track || !bar || value === null) return;
  track.classList.remove("indeterminate");
  bar.style.width = `${value}%`;
}

async function openPage(context: UpdateContext, current: AppUpdate) {
  try {
    await invoke("open_web_link", { url: current.pageUrl });
    dismissed = true;
    stage = "ask";
  } catch (error) {
    stage = "failed";
    problem = String(error);
  }
  context.render();
}

async function install(context: UpdateContext, current: AppUpdate) {
  if (!current.canInstall) return openPage(context, current);
  dismissed = false;
  stage = "downloading";
  progress = null;
  context.render();
  const stop = await listen<{ downloaded: number; total: number }>("app-update-progress", ({ payload }) => {
    progress = payload;
    paintProgress();
  });
  try {
    // On success the app closes while the installer starts.
    await invoke("install_app_update");
  } catch (error) {
    stage = "failed";
    problem = String(error);
    context.render();
  } finally {
    stop();
  }
}

/** Call after the other dialogs have opened, so this one shows on top of Settings. */
export function bindAppUpdateDialog(context: UpdateContext) {
  document.querySelector("[data-action='check-app-update']")?.addEventListener("click", () => void checkFromSettings(context));
  if (update) {
    const found = update;
    document.querySelector("[data-action='settings-app-update']")?.addEventListener("click", () => void install(context, found));
  }
  const dialog = document.querySelector<HTMLDialogElement>("#app-update-dialog");
  if (!dialog || !update) return;
  const current = update;
  dialog.querySelector("[data-action='app-update']")?.addEventListener("click", (event) => {
    event.preventDefault();
    void install(context, current);
  });
  dialog.querySelector("[data-action='open-update-page']")?.addEventListener("click", (event) => {
    event.preventDefault();
    void openPage(context, current);
  });
  // A download can't be walked away from halfway.
  dialog.addEventListener("cancel", (event) => {
    if (stage === "downloading") event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (stage === "downloading") return;
    dismissed = true;
    stage = "ask";
    context.render();
  });
  if (!dialog.open) dialog.showModal();
  paintProgress();
}
