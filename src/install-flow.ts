import { invoke } from "@tauri-apps/api/core";
import { formatBytes } from "./domain";
import type { Campaign, InstallProgress, InstallResult } from "./types";
import type { InstallFailure } from "./install-status";

type MessageKind = "neutral" | "success" | "error";
type InstallFlow = {
  // Catalog and local mods, plus mods only known from the install history.
  campaign: (id: string) => Campaign | undefined;
  gameDir: () => string;
  profileDir: () => string;
  activity: () => InstallProgress | null;
  message: () => string;
  isCurrent: (campaign: Campaign) => boolean;
  setBusy: (value: boolean) => void;
  setActivity: (value: InstallProgress | null) => void;
  setCampaignId: (value: string) => void;
  setFailure: (value: InstallFailure | null) => void;
  setMessage: (value: string, kind: MessageKind) => void;
  inspectDirectory: () => Promise<void>;
  // Switches a campaign back to Blizzard's (Restore original); true when it worked.
  restore: (targetPath: string) => Promise<boolean>;
  play: () => Promise<void>;
  // An install that runs without the dialog shows its progress on the page.
  onStart: () => void;
  render: () => void;
};

type StarcraftStatus = { running: boolean; inMission: boolean | null };
type Pending = { kind: "install"; id: string } | { kind: "restore"; targetPath: string };
type CloseOutcome = { closed: boolean; savedAs: string | null };
// A switch while StarCraft II runs goes through one dialog: ask to close it, save the
// mission and close the game, install, then offer to open it again. "unsaved" is a
// mission the game wouldn't save: the player decides whether to close anyway.
type Stage = "ask" | "closing" | "unsaved" | "working" | "done" | "failed";
// `repair` is decided up front: once installed, the mod is always the current one.
let modal: {
  pending: Pending; stage: Stage; inMission: boolean | null; repair: boolean; error: string; savedAs: string | null;
} | null = null;

// The player's local time for the save's name; Windows file names can't hold ":".
const saveStamp = (now = new Date()) => {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

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

export const requestInstall = (flow: InstallFlow, campaignId: string) => void begin(flow, { kind: "install", id: campaignId });
export const requestRestore = (flow: InstallFlow, targetPath: string) => void begin(flow, { kind: "restore", targetPath });

const repairing = (flow: InstallFlow, pending: Pending) => {
  const campaign = pending.kind === "install" ? flow.campaign(pending.id) : undefined;
  return campaign ? flow.isCurrent(campaign) : false;
};

/// One click installs. Only a running StarCraft II stops it, and then the dialog asks
/// to close the game first (the backend refuses to switch under it either way).
async function begin(flow: InstallFlow, pending: Pending) {
  let status: StarcraftStatus = { running: false, inMission: null };
  try {
    status = await invoke<StarcraftStatus>("starcraft_status");
  } catch {
    // The backend still refuses a switch under a running game.
  }
  if (status.running) {
    modal = { pending, stage: "ask", inMission: status.inMission, repair: repairing(flow, pending), error: "", savedAs: null };
    flow.render();
    return;
  }
  flow.onStart();
  await run(flow, pending);
}

const run = (flow: InstallFlow, pending: Pending) =>
  pending.kind === "restore" ? flow.restore(pending.targetPath) : installCampaign(flow, pending.id);

async function closeAndRun(flow: InstallFlow, keepMission: boolean) {
  if (!modal) return;
  const pending = modal.pending;
  modal.stage = "closing";
  flow.render();
  try {
    const outcome = await invoke<CloseOutcome>("close_starcraft", {
      gameDir: flow.gameDir(), profileDir: flow.profileDir(), stamp: saveStamp(), keepMission,
    });
    if (!outcome.closed) {
      modal.stage = "unsaved";
      flow.render();
      return;
    }
    modal.savedAs = outcome.savedAs;
  } catch (error) {
    modal = { ...modal, stage: "failed", error: String(error) };
    flow.render();
    return;
  }
  modal.stage = "working";
  flow.render();
  const ok = await run(flow, pending);
  if (!modal) return;
  // The page keeps the error too, with its diagnostics.
  modal = ok ? { ...modal, stage: "done" } : { ...modal, stage: "failed", error: flow.message() };
  flow.render();
}

function heading(flow: InstallFlow, pending: Pending) {
  if (pending.kind === "restore") return `Original ${escapeHtml(BASE_CAMPAIGNS[pending.targetPath] ?? "campaign")}`;
  const campaign = flow.campaign(pending.id);
  return campaign ? `${escapeHtml(campaign.title)} <span class="dialog-version">v${escapeHtml(campaign.version)}</span>` : "";
}

function progressBar(activity: InstallProgress | null) {
  const percent = activity?.downloadedBytes != null && activity.totalBytes ? Math.min(100, Math.round(activity.downloadedBytes / activity.totalBytes * 100)) : null;
  const detail = percent !== null
    ? `${formatBytes(activity!.downloadedBytes!)} / ${formatBytes(activity!.totalBytes!)} · ${percent}%`
    : activity?.completedFiles != null && activity.totalFiles != null ? `${activity.completedFiles} / ${activity.totalFiles} files` : "";
  return `<div class="install-progress">${detail ? `<div><strong>${escapeHtml(detail)}</strong></div>` : ""}
    <div class="progress-track ${percent === null ? "indeterminate" : ""}" aria-label="Installation progress"><i style="width: ${percent ?? 100}%"></i></div></div>`;
}

function body(flow: InstallFlow, current: NonNullable<typeof modal>) {
  const installing = current.pending.kind === "install";
  const repair = current.repair;
  switch (current.stage) {
    case "ask": {
      const save = current.inMission === false ? ""
        : `<p class="dialog-note">${current.inMission ? "You're in a mission. CCM Reborn" : "If you're in a mission, CCM Reborn"} <strong>saves it before closing</strong>.</p>`;
      return `<p class="dialog-note">To ${repair ? "repair this mod" : installing ? "install this mod" : "switch back to Blizzard's campaign"}, StarCraft II needs to be closed.</p>${save}
        <div class="dialog-actions">
          <button class="stop" value="cancel" data-action="cancel-install">Cancel</button>
          <button class="go" data-action="close-starcraft" autofocus>Close now</button>
        </div>`;
    }
    case "closing":
      return `<p class="dialog-note dialog-working"><span class="dialog-spinner" aria-hidden="true"></span>${current.inMission === false ? "Closing StarCraft II…" : "Saving your mission and closing StarCraft II…"}</p>`;
    case "unsaved":
      return `<p class="dialog-note">CCM Reborn couldn't save your mission. <strong>Save it in the game yourself</strong>, then close the game here.</p>
        <div class="dialog-actions">
          <button class="stop" value="cancel" data-action="cancel-install" autofocus>Cancel</button>
          <button class="ghost" data-action="close-unsaved">Close StarCraft II</button>
        </div>`;
    case "working": {
      const activity = flow.activity();
      return `<p class="dialog-note">${escapeHtml(activity?.message || (installing ? "Installing…" : "Switching…"))}</p>${progressBar(activity)}`;
    }
    case "done":
      return `<p class="dialog-note">${repair ? "Repaired." : installing ? "Installed." : "Switched."}${current.savedAs ? ` Your mission is saved as <strong>${escapeHtml(current.savedAs)}</strong>.` : ""} Open StarCraft II again?</p>
        <div class="dialog-actions">
          <button class="ghost" value="cancel" data-action="cancel-install">No, thanks</button>
          <button class="go" data-action="reopen-starcraft" autofocus>Open StarCraft II</button>
        </div>`;
    case "failed":
      return `<p class="dialog-note">${escapeHtml(current.error)}</p>
        <div class="dialog-actions"><button class="ghost" value="cancel" data-action="cancel-install" autofocus>Close</button></div>`;
  }
}

export function renderInstallConfirm(flow: InstallFlow) {
  if (!modal) return "";
  return `
    <dialog id="install-confirm-dialog">
      <form method="dialog" class="dialog-card">
        <div><p class="eyebrow">${modal.pending.kind === "restore" ? "SWITCH" : modal.repair ? "REPAIR" : "INSTALL"}</p><h2>${heading(flow, modal.pending)}</h2></div>
        ${body(flow, modal)}
      </form>
    </dialog>`;
}

export function bindInstallConfirm(flow: InstallFlow) {
  const dialog = document.querySelector<HTMLDialogElement>("#install-confirm-dialog");
  if (!dialog || !modal) return;
  // Esc can't interrupt closing the game or an install.
  dialog.addEventListener("cancel", (event) => {
    if (modal?.stage === "closing" || modal?.stage === "working") event.preventDefault();
  });
  // Esc, Cancel, No thanks and Close all end up here.
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "keep") return;
    modal = null;
    flow.render();
  });
  dialog.querySelector("[data-action='close-starcraft']")?.addEventListener("click", (event) => {
    event.preventDefault();
    void closeAndRun(flow, true);
  });
  dialog.querySelector("[data-action='close-unsaved']")?.addEventListener("click", (event) => {
    event.preventDefault();
    void closeAndRun(flow, false);
  });
  dialog.querySelector("[data-action='reopen-starcraft']")?.addEventListener("click", (event) => {
    event.preventDefault();
    modal = null;
    dialog.close("keep");
    void flow.play();
  });
  // Every render() builds a fresh dialog element; it must open without a flash.
  if (!dialog.open) dialog.showModal();
}

async function installCampaign(flow: InstallFlow, campaignId: string) {
  const campaign = flow.campaign(campaignId);
  const gameDir = flow.gameDir();
  const profileDir = flow.profileDir();
  if (!campaign || !gameDir || !profileDir) return false;
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
    return true;
  } catch (error) {
    recordFailure(flow, "preparing-install", error);
    return false;
  } finally {
    flow.setBusy(false); flow.render();
  }
}
