import { invoke } from "@tauri-apps/api/core";
import type { Campaign, InstallProgress, InstallResult } from "./types";
import type { InstallFailure } from "./install-status";

type MessageKind = "neutral" | "success" | "error";
type InstallFlow = {
  // Catalog and local mods, plus mods only known from the install history.
  campaign: (id: string) => Campaign | undefined;
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
  // Switches a campaign back to Blizzard's (Restore original).
  restore: (targetPath: string) => Promise<void>;
  render: () => void;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// The switch waiting for the player's one confirmation.
type Pending = { kind: "install"; id: string } | { kind: "restore"; targetPath: string };
let confirming: Pending | null = null;

const BASE_CAMPAIGNS: Record<string, string> = {
  "Maps/Campaign": "Wings of Liberty", "Maps/Campaign/swarm": "Heart of the Swarm",
  "Maps/Campaign/void": "Legacy of the Void", "Maps/Campaign/nova": "Nova Covert Ops",
};

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
  confirming = { kind: "install", id: campaignId };
  flow.render();
}

export function requestRestore(flow: InstallFlow, targetPath: string) {
  confirming = { kind: "restore", targetPath };
  flow.render();
}

function dialog(eyebrow: string, title: string, note: string, action: string) {
  return `
    <dialog id="install-confirm-dialog">
      <form method="dialog" class="dialog-card">
        <div><p class="eyebrow">${eyebrow}</p><h2>${title}</h2></div>
        <p class="dialog-note">${note}</p>
        <div class="dialog-actions">
          <button class="ghost" value="cancel" data-action="cancel-install">Cancel</button>
          <button class="primary" value="default" data-action="confirm-install" autofocus>${action}</button>
        </div>
      </form>
    </dialog>`;
}

export function renderInstallConfirm(flow: InstallFlow) {
  if (confirming?.kind === "restore") {
    const base = BASE_CAMPAIGNS[confirming.targetPath] ?? "this campaign";
    return dialog("SWITCH", `Original ${escapeHtml(base)}`,
      `Close StarCraft II first. This switches ${escapeHtml(base)} back to Blizzard's campaign. Your current mod and its saves are kept, so you can switch back any time.`,
      "Switch");
  }
  const campaign = confirming ? flow.campaign(confirming.id) : undefined;
  if (!campaign) return "";
  const repair = flow.isCurrent(campaign);
  const base = escapeHtml(campaign.requirements.campaign);
  return dialog(repair ? "REPAIR" : "INSTALL",
    `${escapeHtml(campaign.title)} <span class="dialog-version">v${escapeHtml(campaign.version)}</span>`,
    repair
      ? `Close StarCraft II first. CCM Reborn reinstalls this mod's files for ${base}.`
      : `Close StarCraft II first. This replaces what you have installed for ${base}. CCM Reborn keeps a backup and your saves, so you can switch back any time.`,
    repair ? "Repair" : "Install");
}

export function bindInstallConfirm(flow: InstallFlow, onStart: () => void) {
  const dialog = document.querySelector<HTMLDialogElement>("#install-confirm-dialog");
  if (!dialog) return;
  // Esc, the Cancel button and a backdrop close all end up here.
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "default") return;
    confirming = null;
    flow.render();
  });
  dialog.querySelector("[data-action='confirm-install']")?.addEventListener("click", (event) => {
    event.preventDefault();
    const pending = confirming;
    confirming = null;
    dialog.close("default");
    onStart();
    if (pending?.kind === "restore") void flow.restore(pending.targetPath);
    else if (pending) void installCampaign(flow, pending.id);
  });
  if (!dialog.open) dialog.showModal();
}

async function installCampaign(flow: InstallFlow, campaignId: string) {
  const campaign = flow.campaign(campaignId);
  const gameDir = flow.gameDir();
  const profileDir = flow.profileDir();
  if (!campaign || !gameDir || !profileDir) return;
  const preparing = `Preparing ${campaign.title} for installation…`;
  flow.setBusy(true); flow.setCampaignId(campaign.id);
  flow.setActivity(pendingActivity("preparing-install", preparing)); flow.setFailure(null); flow.setMessage(preparing, "neutral"); flow.render();
  try {
    const result = campaign.isCcm
      // Installed in place from the original CCM's folder.
      ? await invoke<InstallResult>("install_ccm_store_mod", { gameDir, profileDir, id: campaign.id })
      : await invoke<InstallResult>("install_campaign", { request: requestFor(campaign, gameDir, profileDir) });
    flow.setMessage(`Installed ${result.title} v${result.version}. Press Play StarCraft II to start.`, "success");
    flow.setActivity(null); flow.setCampaignId("");
    await flow.inspectDirectory();
  } catch (error) {
    recordFailure(flow, "preparing-install", error);
  } finally {
    flow.setBusy(false); flow.render();
  }
}
