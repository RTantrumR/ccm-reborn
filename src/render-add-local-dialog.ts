import type { LocalPackageInspection } from "./types";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 * 1024 ? 1 : 0)} MB`;

/// Name, author and version come from the archive's own `metadata.txt`; they are
/// the mod author's to set, so the player only confirms.
export function renderAddLocalDialog(inspection: LocalPackageInspection, archivePath: string) {
  const byline = [inspection.author, inspection.version ? `v${inspection.version}` : ""].filter(Boolean).join(" · ");
  const fileName = archivePath.split(/[\\/]/).pop() ?? archivePath;
  return `
    <dialog id="add-local-mod-dialog">
      <form method="dialog" class="dialog-card">
        <button class="close" value="cancel" data-action="cancel-local-mod" aria-label="Close">×</button>
        <div>
          <p class="eyebrow">ADD A MOD FROM YOUR COMPUTER</p>
          <h2>${escapeHtml(inspection.title)}</h2>
          ${byline ? `<p class="dialog-byline">${escapeHtml(byline)}</p>` : ""}
        </div>
        <div class="metadata">
          <div><small>CAMPAIGN</small><strong>${escapeHtml(inspection.campaign)}</strong></div>
          <div><small>SIZE</small><strong>${formatBytes(inspection.size)}</strong></div>
        </div>
        <p class="dialog-note">
          CCM Reborn keeps its own copy of <code>${escapeHtml(fileName)}</code>, so the mod keeps working
          after you move or delete that file.
        </p>
        <p class="dialog-note">Adding changes nothing in StarCraft II. You choose Install afterwards.</p>
        <div class="dialog-actions">
          <button class="ghost" value="cancel" data-action="cancel-local-mod">Cancel</button>
          <button class="primary" value="default" data-action="confirm-local-mod" autofocus>Add to my list</button>
        </div>
      </form>
    </dialog>`;
}
