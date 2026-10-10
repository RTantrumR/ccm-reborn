/// Mirrors SlotCheck in part25_slot_check.rs.
export type SlotCheck = { title: string; changed: number; missingBackups: number };

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

const files = (count: number) => count === 1 ? "1 file" : `${count} files`;

/// The switch dialog's first step when the mod being replaced has files the player
/// changed since it was installed ("changed"), or CCM Reborn's copies of what was
/// there before are gone ("lost"). `original` names the base campaign, `install`
/// says the player was switching to another mod.
export function slotProblem(stage: "changed" | "lost", check: SlotCheck, original: string, install: boolean) {
  const title = `<strong>${escapeHtml(check.title)}</strong>`;
  const changed = check.changed ? `${files(check.changed)} of ${title} ${check.changed === 1 ? "was" : "were"} changed after it was installed.` : "";
  if (stage === "changed") {
    return `<p class="dialog-note">${changed} Switching replaces them, so CCM Reborn keeps a copy of them first.</p>
      <div class="dialog-actions">
        <button class="stop" value="cancel" data-action="cancel-install">Cancel</button>
        <button class="go" data-action="keep-and-switch" autofocus>Keep a copy and switch</button>
      </div>`;
  }
  const name = `Original ${escapeHtml(original)}`;
  return `<p class="dialog-note">${files(check.missingBackups)} CCM Reborn saved before installing ${title} ${check.missingBackups === 1 ? "is" : "are"} gone, so what was there before can't be fully put back.</p>
    ${changed ? `<p class="dialog-note">${changed} A copy of them is kept first.</p>` : ""}
    <p class="dialog-note">You can switch to ${name} instead.${install ? " Then pick the mod again." : ""}</p>
    <div class="dialog-actions">
      <button class="stop" value="cancel" data-action="cancel-install">Cancel</button>
      <button class="go" data-action="switch-original" autofocus>Switch to ${name}</button>
    </div>`;
}
