import type { StarcraftProfileCandidate } from "./types";
import { installSetting } from "./install-flow";
import { appUpdateSetting } from "./app-update";
import { profileName } from "./resume";

type SettingsDialogContext = {
  gameDir: string;
  profileCandidates: StarcraftProfileCandidate[];
  profileDirDraft: string;
  busy: boolean;
  // The answer to the last action here, under the buttons it belongs to.
  note: { text: string; kind: "neutral" | "success" | "error"; area: "game" | "profile" } | null;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

function profileOptionLabel(path: string, index: number) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const account = parts.at(-2);
  const label = profileName(path);
  return `${account ? `${account} / ` : ""}${label}${index === 0 ? " (recent)" : ""}`;
}

export function renderSettingsDialog(context: SettingsDialogContext) {
  const {
    gameDir,
    profileCandidates,
    profileDirDraft,
    busy,
    note,
  } = context;
  const noteFor = (area: "game" | "profile") => note?.area === area ? `<p class="settings-note ${note.kind}" role="status">${escapeHtml(note.text)}</p>` : "";
  // Saving reloads the Library; during an install that would mark the app idle while it still works.
  const waiting = busy ? 'disabled title="Wait until the current task finishes"' : "";
  return `
    <dialog id="settings-dialog">
      <form method="dialog" class="dialog-card">
        <button class="close" value="cancel" aria-label="Close">×</button>
        <p class="eyebrow">SETTINGS</p><h2>Game location</h2>
        <section class="detected-directory">
          <small>STARCRAFT II DIRECTORY</small>
          <strong>${gameDir ? escapeHtml(gameDir) : "No installation detected"}</strong>
          <span>Auto-detection runs when CCM Reborn starts. Choose a folder only if it missed your installation.</span>
        </section>
        <div class="directory-actions">
          <button type="button" class="ghost" data-action="choose-directory">Choose folder…</button>
          <button type="button" class="ghost" data-action="detect-directory">Detect again</button>
        </div>
        ${noteFor("game")}
        <label>StarCraft II profile
          <select id="profile-directory">
            <option value="">Choose before applying an install…</option>
            ${profileCandidates.map((profile, index) => `<option value="${escapeHtml(profile.path)}" ${profile.path === profileDirDraft ? "selected" : ""}>${escapeHtml(profileOptionLabel(profile.path, index))}</option>`).join("")}
          </select>
          <small>This is the single account profile whose bank, saves, and campaign progress CCM Reborn may switch. The first detected profile is selected automatically; choose the other one only if that is the account you play on.</small>
          ${profileDirDraft ? `<small class="profile-path">${escapeHtml(profileDirDraft)}</small>` : ""}
        </label>
        <div class="directory-actions">
          <button type="button" class="ghost" data-action="choose-profile">Choose profile…</button>
          <button type="button" class="ghost" data-action="detect-profiles">Find profiles</button>
        </div>
        ${noteFor("profile")}
        ${installSetting()}
        ${appUpdateSetting()}
        <div class="dialog-actions">
          <button class="ghost" value="cancel">Cancel</button>
          <button class="primary" value="default" data-action="save-settings" ${waiting}>Save</button>
        </div>
      </form>
    </dialog>`;
}
