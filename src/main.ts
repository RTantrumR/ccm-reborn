import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";
import ccmLogo from "./assets/ccm-logo.png";
import { mountWindowControls } from "./window-controls";
import { blockBrowserControls } from "./browser-keys";
import type {
  Campaign, Catalog, GameDirectoryCandidate, Inspection,
  InstallProgress, RestoreResult, SavedCampaignResume, StarcraftProfileCandidate,
} from "./types";
import { fitLibraryDetail, keepLibraryScroll, renderLibrary } from "./render-library";
import { findCampaign, installAction, isCommunityCampaign, isCurrentCatalogCampaign } from "./domain";
import { resumeFor } from "./resume";
import { migrateLegacyProfile, renderLegacyMigration } from "./legacy-migration";
import { renderDashboard } from "./render-dashboard";
import { renderGameBanner } from "./game-banner";
import { bindMyMods, myModsCampaign, refreshInstalledMods, renderMyMods, withCcmStore } from "./my-mods";
import { copyDiagnosticsMessage, InstallFailure, openInstallLogFolder, renderInstallStatus } from "./install-status";
import { bindInstallConfirm, renderInstallConfirm, requestInstall, requestRestore } from "./install-flow";
import { renderSettingsDialog } from "./render-settings-dialog";
import { noteLaunched, playButtonLabel, starcraftLaunching, starcraftRunning, watchStarcraft } from "./starcraft-watch";
import { bindLocalModEvents, localModDialog, localModsHeaderButton, mergeCatalog, refreshLocalMods } from "./local-mods";
import { archiveCampaigns, bindArchive, refreshArchive } from "./archive";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing.");
const root = app;

// The Library lists the Campaign Archive (archive.ts); upstream's catalog source is gone.
localStorage.removeItem("ccm-catalog-source");
let gameDir = localStorage.getItem("ccm-game-directory") ?? "";
let profileDir = localStorage.getItem("ccm-profile-directory") ?? "";
let profileCandidates: StarcraftProfileCandidate[] = [];
// Mods on this PC (added from disk, and the original CCM's); see local-mods.ts, my-mods.ts.
let catalog: Catalog | null = null;
let inspection: Inspection | null = null;
let savedResumes: SavedCampaignResume[] = [];
type Page = "dashboard" | "mymods" | "library";
const PAGE_TITLES: Record<Page, string> = { dashboard: "Campaigns", mymods: "My Mods", library: "Library" };
let page: Page = "dashboard";
let selectedId = "";
let libraryFilter = "";
let message = "Getting your campaigns ready…";
let messageKind: "neutral" | "success" | "error" = "neutral";
let busy = false;
let battleNetMessageTimer: number | undefined;
let installActivity: InstallProgress | null = null;
let activeInstallCampaignId = "";
let diagnosticLogPath = "";
let lastInstallFailure: InstallFailure | null = null;
let scrollToInstallStatus = false;
let settingsOpen = false;
let settingsProfileDirDraft = profileDir;

const installFlow = {
  gameDir: () => gameDir, profileDir: () => profileDir,
  campaign: (id: string) => findCampaign(id, catalog?.campaigns ?? [], archiveCampaigns()) ?? myModsCampaign(id),
  activity: () => installActivity,
  message: () => message,
  isCurrent: (campaign: Campaign) => isCurrentCatalogCampaign(campaign, inspection),
  actionFor: (campaign: Campaign) => installAction(campaign, inspection),
  setBusy: (value: boolean) => { busy = value; },
  setActivity: (value: InstallProgress | null) => { installActivity = value; },
  setCampaignId: (value: string) => { activeInstallCampaignId = value; },
  setFailure: (value: InstallFailure | null) => { lastInstallFailure = value; },
  setMessage: (value: string, kind: "neutral" | "success" | "error") => { message = value; messageKind = kind; },
  inspectDirectory, render,
  play: () => playStarcraft(),
  reloadLocalMods: () => localModsContext.reload(),
  onStart: () => { scrollToInstallStatus = true; },
};

function render() {
  const restoreLibraryScroll = keepLibraryScroll();
  root.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark" src="${ccmLogo}" alt=""><span>CCM <b>REBORN</b></span></div>
      <p class="eyebrow">CAMPAIGN CONTROL</p>
      <nav>
        <button class="nav-item ${page === "dashboard" ? "active" : ""}" data-page="dashboard"><span>◈</span> Campaigns</button>
        <button class="nav-item ${page === "library" ? "active" : ""}" data-page="library" data-library-filter=""><span>▦</span> Library <strong>${(catalog?.campaigns.filter(isCommunityCampaign).length ?? 0) + archiveCampaigns().length}</strong></button>
        <button class="nav-item ${page === "mymods" ? "active" : ""}" data-page="mymods"><span>◆</span> My Mods</button>
      </nav>
      <button class="nav-item nav-settings" data-action="show-settings"><span>⚙</span> Settings</button>
      <div class="sidebar-footer">
        <div class="dot ${gameDir ? "" : "muted"}"></div>
        <div><small>STARCRAFT II</small><br />${gameDir ? "Detected" : "Not found"}</div>
      </div>
      ${gameDir ? `<button class="primary play-button" data-action="play-sc2" ${busy || starcraftRunning() || starcraftLaunching() ? "disabled" : ""}>${playButtonLabel()}</button>` : ""}
    </aside>
    <main>
      <header>
        <div><h1>${PAGE_TITLES[page]}</h1></div>
        <div class="header-actions">
          <button class="ghost compact" data-action="refresh-catalog" ${busy ? "disabled" : ""}>Check for updates</button>${localModsHeaderButton(busy)}
        </div>${renderGameBanner(gameDir, profileDir)}
      </header>
      ${renderInstallStatus({ message, messageKind, activity: installActivity, failure: lastInstallFailure, logPath: diagnosticLogPath, busy })}
      ${renderLegacyMigration(catalog, savedResumes, profileDir, busy)}
      ${page === "mymods" ? renderMyMods({ catalog, inspection, busy, gameDir, profileDir }) : page === "dashboard" ? renderDashboard({ catalog, inspection, savedResumes, busy, gameDir, profileDir, isCurrentCatalogCampaign: (campaign) => isCurrentCatalogCampaign(campaign, inspection) }) : renderLibrary({ catalog, archive: archiveCampaigns(), inspection, selectedId, filter: libraryFilter, busy, gameDir, profileDir, installingCampaignId: activeInstallCampaignId, isCurrentCatalogCampaign: (campaign) => isCurrentCatalogCampaign(campaign, inspection) })}
    </main>
    ${renderSettingsDialog({
      gameDir,
      profileCandidates,
      profileDirDraft: settingsProfileDirDraft,
      busy,
    })}
    ${renderInstallConfirm(installFlow)}
    ${localModDialog()}
  `;
  bindEvents();
  restoreLibraryScroll();
  const addLocalDialog = document.querySelector<HTMLDialogElement>("#add-local-mod-dialog");
  if (addLocalDialog && !addLocalDialog.open) addLocalDialog.showModal();
  const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog");
  if (settingsOpen && settingsDialog && !settingsDialog.open) settingsDialog.showModal();
  if (scrollToInstallStatus) {
    scrollToInstallStatus = false;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".status.installing")?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  }
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      page = (button.dataset.page ?? "dashboard") in PAGE_TITLES ? button.dataset.page as Page : "dashboard";
      // View, See all and the filter chips also choose what the Library shows.
      if (button.dataset.libraryFilter !== undefined) libraryFilter = button.dataset.libraryFilter;
      if (button.dataset.select) selectedId = button.dataset.select;
      window.scrollTo(0, 0);
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-library-campaign]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.libraryCampaign ?? "";
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action='show-settings']").forEach((button) => {
    button.addEventListener("click", () => showSettings());
  });
  document.querySelector<HTMLDialogElement>("#settings-dialog")?.addEventListener("close", () => {
    settingsOpen = false;
  });
  const profileDirectorySelect = document.querySelector<HTMLSelectElement>("#profile-directory");
  profileDirectorySelect?.addEventListener("change", () => {
    settingsProfileDirDraft = profileDirectorySelect.value;
  });
  document.querySelector<HTMLButtonElement>("[data-action='save-settings']")?.addEventListener("click", (event) => {
    event.preventDefault();
    profileDir = settingsProfileDirDraft.trim();
    if (profileDir) localStorage.setItem("ccm-profile-directory", profileDir);
    else localStorage.removeItem("ccm-profile-directory");
    settingsOpen = false;
    document.querySelector<HTMLDialogElement>("#settings-dialog")?.close();
    void loadLibrary();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action='choose-directory']").forEach((button) => button.addEventListener("click", () => void chooseGameDirectory()));
  document.querySelector<HTMLButtonElement>("[data-action='refresh-catalog']")?.addEventListener("click", () => void loadLibrary());
  document.querySelector<HTMLButtonElement>("[data-action='detect-directory']")?.addEventListener("click", () => void detectGameDirectory());
  document.querySelectorAll<HTMLButtonElement>("[data-action='choose-profile']").forEach((button) => button.addEventListener("click", () => void chooseProfileDirectory()));
  document.querySelector<HTMLButtonElement>("[data-action='detect-profiles']")?.addEventListener("click", () => void refreshProfiles(true));
  document.querySelectorAll<HTMLButtonElement>("[data-action='install']").forEach((button) => {
    button.addEventListener("click", () => requestInstall(installFlow, button.dataset.campaign ?? "", true));
  });
  bindInstallConfirm(installFlow);
  bindArchive((text) => { message = text; messageKind = "error"; render(); });
  fitLibraryDetail();
  bindMyMods((targetPath, value) => value === "original" ? requestRestore(installFlow, targetPath) : requestInstall(installFlow, value));
  document.querySelector<HTMLButtonElement>("[data-action='play-sc2']")?.addEventListener("click", () => void playStarcraft());
  document.querySelectorAll<HTMLButtonElement>("[data-action='restore']").forEach((button) => {
    button.addEventListener("click", () => requestRestore(installFlow, button.dataset.target ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action='migrate-legacy']").forEach((button) => {
    button.addEventListener("click", () => void migrateLegacySnapshot(button.dataset.campaign ?? ""));
  });
  document.querySelector<HTMLButtonElement>("[data-action='dismiss-status']")?.addEventListener("click", () => { message = ""; render(); });
  document.querySelector<HTMLButtonElement>("[data-action='copy-diagnostics']")?.addEventListener("click", () => void copyDiagnostics());
  document.querySelector<HTMLButtonElement>("[data-action='open-log-folder']")?.addEventListener("click", () => void openDiagnosticLogFolder());
  bindLocalModEvents(
    localModsContext,
    catalog?.campaigns ?? [],
    inspection?.managedCampaigns.map((campaign) => campaign.id) ?? [],
  );
}

function showSettings() {
  settingsProfileDirDraft = profileDir;
  settingsOpen = true;
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

async function copyDiagnostics() {
  const result = await copyDiagnosticsMessage(lastInstallFailure, diagnosticLogPath);
  if (result) {
    message = result.text;
    messageKind = result.kind;
  }
  render();
}

async function openDiagnosticLogFolder() {
  await openInstallLogFolder().catch((error) => {
    message = String(error);
    messageKind = "error";
    render();
  });
}

async function resolveGameDirectory(path: string) {
  return invoke<GameDirectoryCandidate>("resolve_game_directory", { path });
}

async function chooseGameDirectory() {
  const selected = await open({ directory: true, multiple: false, title: "Choose StarCraft II or its installation folder" });
  if (typeof selected !== "string") return;
  try {
    const game = await resolveGameDirectory(selected);
    setGameDirectory(game);
    await refreshProfiles();
    message = `StarCraft II directory selected: ${game.label}`;
    messageKind = "success";
    await inspectDirectory();
  } catch (error) {
    message = String(error);
    messageKind = "error";
  }
  render();
}

/// Any folder the player picks (Documents\StarCraft II, Accounts, or a profile) resolves to
/// one real profile in the backend, or is refused with a plain explanation.
const resolveProfile = (path: string) => invoke<StarcraftProfileCandidate>("resolve_starcraft_profile", { path });

function useProfile(profile: StarcraftProfileCandidate) {
  profileDir = profile.path;
  settingsProfileDirDraft = profileDir;
  localStorage.setItem("ccm-profile-directory", profileDir);
  if (!profileCandidates.some((candidate) => candidate.path === profileDir)) profileCandidates = [...profileCandidates, profile];
}

async function chooseProfileDirectory() {
  const selected = await open({ directory: true, multiple: false, title: "Choose the StarCraft II folder in your Documents" });
  if (typeof selected !== "string") return;
  try {
    const profile = await resolveProfile(selected);
    useProfile(profile);
    message = `StarCraft II account selected: ${profile.label}`;
    messageKind = "success";
  } catch (error) {
    message = String(error);
    messageKind = "error";
  }
  render();
}

async function refreshProfiles(showMessage = false) {
  try {
    profileCandidates = await invoke<StarcraftProfileCandidate[]>("detect_starcraft_profiles");
    // A saved choice must still be a real profile: a parent folder (for example
    // Documents\StarCraft II) resolves to the profile in it; anything else is dropped.
    if (profileDir && !profileCandidates.some((profile) => profile.path === profileDir)) {
      await resolveProfile(profileDir).then(useProfile, () => {
        profileDir = "";
        localStorage.removeItem("ccm-profile-directory");
      });
    }
    // Detection is ranked by the backend (most recently played first). Select it
    // automatically so a first-run player never has to open Settings.
    if (!profileDir && profileCandidates.length) useProfile(profileCandidates[0]);
    if (showMessage) {
      message = profileCandidates.length ? `${profileCandidates.length} StarCraft II profile(s) found.` : "No StarCraft II profiles were found.";
      messageKind = profileCandidates.length ? "success" : "error";
      render();
    }
  } catch (error) {
    if (showMessage) {
      message = String(error);
      messageKind = "error";
      render();
    }
  }
}

function setGameDirectory(game: GameDirectoryCandidate) {
  if (gameDir !== game.path) {
    profileDir = "";
    settingsProfileDirDraft = "";
    localStorage.removeItem("ccm-profile-directory");
  }
  gameDir = game.path;
  localStorage.setItem("ccm-game-directory", gameDir);
}

type MessageKind = "neutral" | "success" | "error";

/// One busy operation: shows `working` with a spinner while every action is
/// disabled, then reports the task's result, or its error, in the status bar.
async function runTask(working: string, task: () => Promise<string | [string, MessageKind]>) {
  busy = true;
  message = working;
  messageKind = "neutral";
  render();
  try {
    const result = await task();
    [message, messageKind] = typeof result === "string" ? [result, "success"] : result;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    messageKind = "error";
  } finally {
    busy = false;
    render();
  }
}

const detectGameDirectory = () => runTask("Looking for StarCraft II…", async () => {
  const locations = await invoke<GameDirectoryCandidate[]>("detect_game_directories");
  if (!locations.length) throw new Error("StarCraft II was not found in the standard locations. Choose its folder manually.");
  setGameDirectory(locations[0]);
  await refreshProfiles();
  await inspectDirectory();
  return `Found StarCraft II: ${locations[0].label}`;
});

/// The Campaign Archive's mods, the mods on this PC, and what is installed.
async function loadLibrary() {
  // Its end clears "busy", which must stay set while an install runs.
  if (busy) return;
  busy = true;
  message = "Loading campaigns…";
  messageKind = "neutral";
  render();
  try {
    await refreshArchive();
    catalog = mergeCatalog(null, await refreshLocalMods());
    selectedId ||= archiveCampaigns()[0]?.id ?? "";
    message = "";
    await inspectDirectory();
  } catch (error) {
    message = String(error);
    messageKind = "error";
    // What's installed doesn't depend on the Library: My Mods must still show it.
    await inspectDirectory().catch(() => {});
  } finally {
    busy = false;
    render();
  }
}

const localModsContext = {
  busy: () => busy,
  setBusy: (value: boolean) => { busy = value; },
  setMessage: (value: string, kind: "neutral" | "success" | "error") => { message = value; messageKind = kind; },
  show: () => { page = "mymods"; window.scrollTo(0, 0); },
  reload: async () => {
    catalog = mergeCatalog(null, await refreshLocalMods());
    await inspectDirectory();
  },
  render,
};

async function inspectDirectory() {
  await refreshInstalledMods(gameDir);
  catalog = withCcmStore(catalog);
  if (!gameDir) {
    inspection = null;
    savedResumes = [];
    return;
  }
  const [gameInspection, resumes] = await Promise.all([
    invoke<Inspection>("inspect_game_directory", { gameDir, knownCampaigns: catalog?.campaigns ?? [] }),
    invoke<SavedCampaignResume[]>("inspect_saved_campaign_resumes", { gameDir, profileDir: profileDir || null }),
  ]);
  inspection = gameInspection;
  savedResumes = resumes;
  if (inspection.recoveryPerformed) {
    message = "A previously interrupted install was restored safely.";
    messageKind = "success";
  }
}

const migrateLegacySnapshot = (campaignId: string) => runTask("Migrating legacy CCM saves to the selected account…", async () => {
  const result = await migrateLegacyProfile(campaignId, profileDir);
  if (!result) return ["", "neutral"];
  await inspectDirectory();
  return `Migrated ${result.filesCopied} legacy profile files for ${result.campaignId}.`;
});

/// Starts Battle.net if needed, then asks it to launch StarCraft II (the game only
/// gets its login through Battle.net). The backend reports each step.
async function playStarcraft() {
  const opened = "StarCraft II is starting. Choose Campaign in the game's menu.";
  await runTask("Starting StarCraft II…", async () => {
    await invoke("launch_starcraft");
    noteLaunched();
    return opened;
  });
  installActivity = null;
  render();
  // The hint only matters while the player switches windows.
  window.clearTimeout(battleNetMessageTimer);
  battleNetMessageTimer = window.setTimeout(() => {
    if (message === opened) {
      message = "";
      render();
    }
  }, 3500);
}

async function boot() {
  try {
    diagnosticLogPath = await invoke<string>("get_diagnostic_log_path");
  } catch {
    // The installation flow remains usable when the user's home directory is unavailable.
  }
  if (!gameDir) {
    try {
      const locations = await invoke<GameDirectoryCandidate[]>("detect_game_directories");
      if (locations.length) setGameDirectory(locations[0]);
    } catch {
      // A missing installation is a normal first-run state; the dashboard still opens.
    }
  }
  if (gameDir) await refreshProfiles();
  await loadLibrary();
}

blockBrowserControls();
mountWindowControls();
render();
watchStarcraft(() => busy);
void listen<InstallProgress>("install-progress", ({ payload }) => {
  if (!busy) return;
  installActivity = payload;
  message = payload.message;
  messageKind = "neutral";
  render();
});
void boot();
window.addEventListener("focus", () => {
  if (!gameDir || busy) return;
  void inspectDirectory().then(render).catch(() => {
    // The previous inspection stays visible if the game directory disappears.
  });
});
