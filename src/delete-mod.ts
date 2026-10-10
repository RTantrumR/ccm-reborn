import { invoke } from "@tauri-apps/api/core";
import { hideMod } from "./my-mods";

// Deleting a mod from My Mods: one dialog with two choices that are remembered for the next
// time (part27_delete_mod.rs does the deleting). The app's own copies always go; the files it
// came from and its saves only when ticked. An original-CCM mod whose folder stays is hidden.

type DeleteContext = {
  gameDir: () => string;
  profileDir: () => string;
  setBusy: (value: boolean) => void;
  setMessage: (value: string, kind: "neutral" | "success" | "error") => void;
  reload: () => Promise<void>;
  render: () => void;
};

type Pending = { id: string; title: string; hasOriginal: boolean; isCcm: boolean };
let pending: Pending | null = null;

const ORIGINAL = "ccm-delete-original";
const SAVES = "ccm-delete-saves";
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const remember = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Without storage the box starts unticked next time.
  }
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

export function requestDelete(context: DeleteContext, id: string, title: string, hasOriginal: boolean, isCcm: boolean) {
  pending = { id, title, hasOriginal, isCcm };
  context.render();
}

export function renderDeleteDialog() {
  if (!pending) return "";
  const original = pending.hasOriginal
    ? `<label class="dialog-check"><input type="checkbox" id="delete-original" ${remembered(ORIGINAL) ? "checked" : ""}> ${pending.isCcm ? "Also delete it from the original CCM's folder" : "Also delete the file you added it from"}</label>`
    : "";
  return `
    <dialog id="delete-mod-dialog">
      <form method="dialog" class="dialog-card">
        <div><p class="eyebrow">DELETE</p><h2>${escapeHtml(pending.title)}</h2></div>
        <p class="dialog-note">CCM Reborn removes it from your list and deletes its own copies of it.</p>
        ${original}
        <label class="dialog-check"><input type="checkbox" id="delete-saves" ${remembered(SAVES) ? "checked" : ""}> Also delete its saves</label>
        <div class="dialog-actions">
          <button class="ghost" value="cancel" autofocus>Cancel</button>
          <button class="stop" data-action="confirm-delete">Delete</button>
        </div>
      </form>
    </dialog>`;
}

async function confirmDelete(context: DeleteContext, mod: Pending, deleteOriginal: boolean, deleteSaves: boolean) {
  context.setBusy(true);
  context.render();
  try {
    await invoke("delete_mod", {
      gameDir: context.gameDir(), profileDir: context.profileDir() || null, id: mod.id,
      options: { deleteOriginal: mod.hasOriginal && deleteOriginal, deleteSaves },
    });
    if (mod.isCcm && !deleteOriginal) hideMod(mod.id);
    await context.reload();
    context.setMessage(`Deleted ${mod.title}.`, "success");
  } catch (error) {
    context.setMessage(String(error), "error");
  } finally {
    context.setBusy(false);
    context.render();
  }
}

export function bindDeleteDialog(context: DeleteContext) {
  const dialog = document.querySelector<HTMLDialogElement>("#delete-mod-dialog");
  if (!dialog || !pending) return;
  const mod = pending;
  const original = dialog.querySelector<HTMLInputElement>("#delete-original");
  const saves = dialog.querySelector<HTMLInputElement>("#delete-saves")!;
  original?.addEventListener("change", () => remember(ORIGINAL, original.checked));
  saves.addEventListener("change", () => remember(SAVES, saves.checked));
  dialog.querySelector("[data-action='confirm-delete']")?.addEventListener("click", (event) => {
    event.preventDefault();
    pending = null;
    dialog.close("delete");
    void confirmDelete(context, mod, Boolean(original?.checked), saves.checked);
  });
  // Esc, Cancel: nothing is deleted.
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "delete") return;
    pending = null;
    context.render();
  });
  if (!dialog.open) dialog.showModal();
}
