import { invoke } from "@tauri-apps/api/core";
import type { Campaign, Catalog, InstallProgress, InstallResult } from "./types";
import type { InstallFailure } from "./install-status";

type MessageKind = "neutral" | "success" | "error";
type InstallFlow = {
  catalog: () => Catalog | null;
  gameDir: () => string;
  profileDir: () => string;
  activity: () => InstallProgress | null;
  isCurrent: (campaign: Campaign) => boolean;
  setBusy: (value: boolean) => void;
  setActivity: (value: InstallProgress | null) => void;
  setCampaignId: (value: string) => void;
  setFailure: (value: InstallFailure | null) => void;
  setMessage: (value: string, kind: MessageKind) => void;
  inspectDirectory: () => Promise<void>;
  render: () => void;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// The campaign waiting for the player's one confirmation, or "".
let confirmingId = "";

const pendingActivity = (phase: string, message: string): InstallProgress => ({
  operationId: "", phase, message,
  downloadedBytes: null, totalBytes: null, completedFiles: null, totalFiles: null,
});

const requestFor = (campaign: Campaign, gameDir: string, profileDir: string | null) => ({
  campaignId: campaign.id, title: campaign.title, author: campaign.author, version: campaign.version,
  profileDir, archiveSource: campaign.package.source, sha256: campaign.package.sha256,
  packageSize: campaign.package.size, gameDir,
});

function recordFailure(flow: InstallFlow, phase: string, error: unknown) {
  const message = String(error);
  flow.setMessage(message, "error");
  flow.setFailure({ operationId: flow.activity()?.operationId ?? "", phase: flow.activity()?.phase ?? phase, error: message });
  flow.setActivity(null);
  flow.setCampaignId("");
}

/// Install and Repair both ask once, in plain words, then install. The backend
/// verifies the package and keeps rollback copies whether or not a dry-run ran.
export function requestInstall(flow: InstallFlow, campaignId: string) {
  confirmingId = campaignId;
  flow.render();
}

export function renderInstallConfirm(flow: InstallFlow) {
  const campaign = flow.catalog()?.campaigns.find((item) => item.id === confirmingId);
  if (!campaign) return "";
  const repair = flow.isCurrent(campaign);
  const base = campaign.requirements.campaign;
  return `
    <dialog id="install-confirm-dialog">
      <form method="dialog" class="dialog-card">
        <div>
          <p class="eyebrow">${repair ? "REPAIR" : "INSTALL"}</p>
          <h2>${escapeHtml(campaign.title)} <span class="dialog-version">v${escapeHtml(campaign.version)}</span></h2>
        </div>
        <p class="dialog-note">${repair
          ? `Close StarCraft II first. CCM Reborn reinstalls this mod's files for ${escapeHtml(base)}.`
          : `Close StarCraft II first. This replaces what you have installed for ${escapeHtml(base)}. CCM Reborn keeps a backup and your saves, so you can switch back any time.`}</p>
        <div class="dialog-actions">
          <button class="ghost" value="cancel" data-action="cancel-install">Cancel</button>
          <button class="primary" value="default" data-action="confirm-install" autofocus>${repair ? "Repair" : "Install"}</button>
        </div>
      </form>
    </dialog>`;
}

export function bindInstallConfirm(flow: InstallFlow, onStart: () => void) {
  const dialog = document.querySelector<HTMLDialogElement>("#install-confirm-dialog");
  if (!dialog) return;
  // Esc, the Cancel button and a backdrop close all end up here.
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "default") return;
    confirmingId = "";
    flow.render();
  });
  dialog.querySelector("[data-action='confirm-install']")?.addEventListener("click", (event) => {
    event.preventDefault();
    const campaignId = confirmingId;
    confirmingId = "";
    dialog.close("default");
    onStart();
    void installCampaign(flow, campaignId);
  });
  if (!dialog.open) dialog.showModal();
}

async function installCampaign(flow: InstallFlow, campaignId: string) {
  const campaign = flow.catalog()?.campaigns.find((item) => item.id === campaignId);
  const gameDir = flow.gameDir();
  const profileDir = flow.profileDir();
  if (!campaign || !gameDir || !profileDir) return;
  const preparing = `Preparing ${campaign.title} for installation…`;
  flow.setBusy(true); flow.setCampaignId(campaign.id);
  flow.setActivity(pendingActivity("preparing-install", preparing)); flow.setFailure(null); flow.setMessage(preparing, "neutral"); flow.render();
  try {
    const result = await invoke<InstallResult>("install_campaign", { request: requestFor(campaign, gameDir, profileDir) });
    flow.setMessage(`Installed ${result.title} v${result.version}. Open Battle.net and press Play.`, "success");
    flow.setActivity(null); flow.setCampaignId("");
    await flow.inspectDirectory();
  } catch (error) {
    recordFailure(flow, "preparing-install", error);
  } finally {
    flow.setBusy(false); flow.render();
  }
}
