import { invoke } from "@tauri-apps/api/core";
import type { Campaign, Catalog, Inspection } from "./types";
import { byline, campaignSlot, versionTag } from "./domain";

/// Mirrors InstalledModRecord in part18_installed_mods.rs.
export type InstalledModRecord = {
  campaignId: string;
  title: string;
  author: string;
  version: string;
  packageSha256: string;
  targetPath: string;
  campaign: string;
  installedAt: number;
  current: boolean;
  cachedArchive: string | null;
};

/// Mirrors CcmStoreMod in part19_ccm_store.rs.
type CcmStoreMod = {
  id: string;
  title: string;
  author: string;
  version: string;
  description: string;
  campaign: string;
  targetPath: string;
  folder: string;
  size: number;
};

type MyModsContext = {
  catalog: Catalog | null;
  inspection: Inspection | null;
  busy: boolean;
  gameDir: string;
  profileDir: string;
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

const SLOTS = [
  { id: "wings-of-liberty", title: "Wings of Liberty", targetPath: "Maps/Campaign" },
  { id: "heart-of-the-swarm", title: "Heart of the Swarm", targetPath: "Maps/Campaign/swarm" },
  { id: "legacy-of-the-void", title: "Legacy of the Void", targetPath: "Maps/Campaign/void" },
  { id: "nova-covert-ops", title: "Nova Covert Ops", targetPath: "Maps/Campaign/nova" },
];

let installed: InstalledModRecord[] = [];
let ccmStore: CcmStoreMod[] = [];
// The slot whose "Switch to" list is open. Kept here: render() rebuilds the page.
let openPicker = "";

// Original-CCM mods deleted without their folder: the folder stays, My Mods stops listing them.
const HIDDEN = "ccm-hidden-mods";
function hiddenMods(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function hideMod(id: string) {
  try {
    localStorage.setItem(HIDDEN, JSON.stringify([...new Set([...hiddenMods(), id])]));
  } catch {
    // Without storage the mod simply shows again.
  }
}

/// Install history plus the original CCM's folder; both live in the game folder.
export async function refreshInstalledMods(gameDir: string) {
  [installed, ccmStore] = gameDir
    ? await Promise.all([
      invoke<InstalledModRecord[]>("list_installed_mods", { gameDir }).catch(() => []),
      invoke<CcmStoreMod[]>("list_ccm_store", { gameDir }).catch(() => []),
    ])
    : [[], []];
}

/// The original CCM's mods join the catalog like local mods do (replacing any
/// earlier merge, so it is safe to call after every refresh).
export function withCcmStore(catalog: Catalog | null): Catalog | null {
  const base = catalog?.campaigns.filter((campaign) => !campaign.isCcm) ?? [];
  const known = new Set(base.map((campaign) => campaign.id));
  const ccm: Campaign[] = ccmStore.filter((item) => !known.has(item.id)).map((item) => ({
    id: item.id, title: item.title, author: item.author, version: item.version, description: item.description,
    tags: [], requirements: { campaign: item.campaign },
    package: { source: `ccm-store:${item.folder}`, sha256: "", size: item.size }, isCcm: true,
  }));
  if (catalog) return { ...catalog, campaigns: [...base, ...ccm] };
  return ccm.length ? { name: "Your mods", updatedAt: "", sourceKind: "local", campaigns: ccm } : null;
}

/// A mod that has left the catalog can still be reinstalled from its verified
/// cached download. The installer re-checks the SHA-256 of a local source.
function cachedCampaign(record: InstalledModRecord): Campaign {
  return {
    id: record.campaignId, title: record.title, author: record.author, version: record.version,
    description: "", tags: [], requirements: { campaign: record.campaign },
    package: { source: record.cachedArchive ?? "", sha256: record.packageSha256, size: 0 },
  };
}

/// Install-flow lookup for mods that are only known from the install history.
export function myModsCampaign(id: string) {
  const record = installed.find((item) => item.campaignId === id && item.cachedArchive);
  return record ? cachedCampaign(record) : undefined;
}

type Entry = {
  id: string;
  title: string;
  author: string;
  version: string;
  slot: string;
  installedAt: number;
  isLocal: boolean;
  isCcm: boolean;
  installable: boolean;
  // Deleting it can also delete the files it came from (part27_delete_mod.rs).
  hasOriginal: boolean;
};

function collectEntries(catalog: Catalog | null): Entry[] {
  const known = new Map((catalog?.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const entries: Entry[] = installed.map((record) => {
    const campaign = known.get(record.campaignId);
    return {
      id: record.campaignId, title: campaign?.title ?? record.title, author: campaign?.author ?? record.author,
      version: campaign?.version ?? record.version, slot: campaignSlot(record.campaign), installedAt: record.installedAt,
      isLocal: Boolean(campaign?.isLocal), isCcm: Boolean(campaign?.isCcm), installable: Boolean(campaign || record.cachedArchive),
      hasOriginal: Boolean(campaign?.isCcm || campaign?.hasOriginal),
    };
  });
  const listed = new Set(entries.map((entry) => entry.id));
  // Mods added from the player's computer, and those the original CCM installed,
  // belong here before CCM Reborn first installs them too.
  for (const campaign of catalog?.campaigns ?? []) {
    if (!(campaign.isLocal || campaign.isCcm) || listed.has(campaign.id)) continue;
    entries.push({
      id: campaign.id, title: campaign.title, author: campaign.author, version: campaign.version,
      slot: campaignSlot(campaign.requirements.campaign), installedAt: 0,
      isLocal: Boolean(campaign.isLocal), isCcm: Boolean(campaign.isCcm), installable: true,
      hasOriginal: Boolean(campaign.isCcm || campaign.hasOriginal),
    });
  }
  const hidden = new Set(hiddenMods());
  return entries.filter((entry) => !hidden.has(entry.id));
}

const same = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/// What is in the slot right now: CCM Reborn's managed mod, else a mod the original
/// CCM activated (matched by its metadata.txt title and version), else nothing known.
function playingIn(slot: typeof SLOTS[number], entries: Entry[], context: MyModsContext) {
  const managed = context.inspection?.managedCampaigns.find((campaign) => campaign.slot === slot.id);
  if (managed) return { id: managed.id, modified: true };
  const active = context.inspection?.activeCampaigns.find((campaign) => campaign.slot === slot.id);
  if (!active?.isModified) return { id: "", modified: false };
  const matches = entries.filter((entry) => same(entry.title, active.title) && same(entry.version, active.version));
  return { id: (matches.find((entry) => entry.isCcm) ?? matches[0])?.id ?? "", modified: true };
}

const versioned = (title: string, version: string) => byline(title, versionTag(version));

function renderCurrent(slot: typeof SLOTS[number], playing: { id: string; modified: boolean }, entries: Entry[], context: MyModsContext) {
  const entry = entries.find((item) => item.id === playing.id);
  const active = context.inspection?.activeCampaigns.find((campaign) => campaign.slot === slot.id);
  const [title, meta, pill] = entry
    ? [entry.title, versioned(entry.author, entry.version), entry.isLocal ? "LOCAL" : entry.isCcm ? "CCM" : ""]
    : playing.modified && active
      ? [active.title, versioned(active.author, active.version), ""]
      : [`Original ${slot.title}`, "Blizzard", ""];
  // Room for the current mod's screenshot once the CCM website can serve them.
  return `<div class="mymods-current">
    <small>PLAYING NOW</small>
    <strong>${escapeHtml(title)}${pill ? ` <span class="local-pill">${pill}</span>` : ""}</strong>
    ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
  </div>`;
}

const TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5"/></svg>`;

/// "Switch to": our own dropdown, since a <select> can't hold the trash icons. Each row
/// switches to that mod; its trash deletes it (not the playing one).
function renderSwitcher(slot: typeof SLOTS[number], playing: { id: string; modified: boolean }, entries: Entry[], context: MyModsContext) {
  const disabled = !context.gameDir ? 'disabled title="Choose your StarCraft II folder first"'
    : !context.profileDir ? 'disabled title="Choose your StarCraft II account first"'
    : context.busy ? "disabled" : "";
  const unknownMod = playing.modified && !playing.id;
  const sorted = [...entries].sort((left, right) => left.title.localeCompare(right.title) || right.version.localeCompare(left.version));
  const current = sorted.find((entry) => entry.id === playing.id);
  const label = unknownMod ? "A mod that is not in your list" : current ? versioned(current.title, current.version) : `Original ${slot.title}`;
  const open = openPicker === slot.targetPath && !disabled;
  const rows = [
    // Back to Blizzard's campaign is safe only when the current mod is recoverable.
    `<li><button type="button" class="mod-option ${playing.modified ? "" : "selected"}" data-action="pick-mod" data-value="original" ${unknownMod ? "disabled" : ""}>Original ${slot.title}</button></li>`,
    ...sorted.map((entry) => {
      const isPlaying = entry.id === playing.id;
      const name = escapeHtml(versioned(entry.title, entry.version));
      return `<li>
        <button type="button" class="mod-option ${isPlaying ? "selected" : ""}" data-action="pick-mod" data-value="${escapeHtml(entry.id)}" ${entry.installable ? "" : "disabled"}>${name}${entry.installable ? "" : " (no longer available)"}</button>
        <button type="button" class="mod-trash" data-action="delete-mod" data-campaign="${escapeHtml(entry.id)}" aria-label="Delete ${name}" ${isPlaying ? 'disabled title="Playing now. Switch to another mod first."' : ""}>${TRASH}</button>
      </li>`;
    }),
  ].join("");
  return `<div class="mymods-switch"><span>Switch to</span>
    <div class="mod-picker ${open ? "open" : ""}" data-slot="${slot.targetPath}">
      <button type="button" class="mod-switcher" data-action="toggle-picker" aria-haspopup="listbox" aria-expanded="${open}" ${disabled}><span>${escapeHtml(label)}</span><i aria-hidden="true">▾</i></button>
      ${open ? `<ul class="mod-picker-list" role="listbox">${rows}</ul>` : ""}
    </div></div>`;
}

function renderGroup(slot: typeof SLOTS[number], entries: Entry[], context: MyModsContext) {
  const playing = playingIn(slot, entries, context);
  return `<article class="mymods-group faction-${slot.id}">
    <p class="eyebrow">${slot.title}</p>
    ${renderCurrent(slot, playing, entries, context)}
    ${renderSwitcher(slot, playing, entries, context)}
  </article>`;
}

/// One card per base campaign, so all four fit on one screen however many mods
/// there are: what is playing, and a dropdown to switch.
export function renderMyMods(context: MyModsContext) {
  const entries = collectEntries(context.catalog);
  return `<section class="mymods">${SLOTS.map((slot) =>
    renderGroup(slot, entries.filter((entry) => entry.slot === slot.id), context)).join("")}</section>`;
}

type MyModsActions = {
  pick: (targetPath: string, value: string) => void;
  delete: (id: string, title: string, hasOriginal: boolean, isCcm: boolean) => void;
  render: () => void;
};

let closeOnOutside: ((event: MouseEvent | KeyboardEvent) => void) | null = null;

/// The open list stays inside the window: a list hanging below it would add a scrollbar and
/// shift the whole page sideways. It opens upwards when there is more room above, and is no
/// taller than the room it has.
function fitOpenList() {
  const list = document.querySelector<HTMLElement>(".mod-picker.open .mod-picker-list");
  const button = list?.parentElement?.querySelector<HTMLElement>("[data-action='toggle-picker']");
  if (!list || !button) return;
  const margin = 8;
  const box = button.getBoundingClientRect();
  const top = document.querySelector<HTMLElement>(".titlebar")?.offsetHeight ?? 0;
  const below = window.innerHeight - box.bottom - margin;
  const above = box.top - top - margin;
  const up = list.scrollHeight > below && above > below;
  list.classList.toggle("up", up);
  list.style.maxHeight = `${Math.max(120, Math.min(320, up ? above : below))}px`;
}

/// Picking a row switches to it (or to "Original"); the trash asks before deleting.
export function bindMyMods(context: MyModsContext, actions: MyModsActions) {
  const entries = collectEntries(context.catalog);
  const setOpen = (slot: string) => { openPicker = slot; actions.render(); };
  document.querySelectorAll<HTMLElement>(".mod-picker").forEach((picker) => {
    const slot = picker.dataset.slot ?? "";
    picker.querySelector("[data-action='toggle-picker']")?.addEventListener("click", () => setOpen(openPicker === slot ? "" : slot));
    picker.querySelectorAll<HTMLButtonElement>("[data-action='pick-mod']").forEach((option) => option.addEventListener("click", () => {
      openPicker = "";
      if (option.classList.contains("selected")) return actions.render();
      actions.pick(slot, option.dataset.value ?? "");
    }));
    picker.querySelectorAll<HTMLButtonElement>("[data-action='delete-mod']").forEach((trash) => trash.addEventListener("click", () => {
      const entry = entries.find((item) => item.id === trash.dataset.campaign);
      openPicker = "";
      if (entry) actions.delete(entry.id, versioned(entry.title, entry.version), entry.hasOriginal, entry.isCcm);
    }));
  });
  fitOpenList();
  // A click elsewhere, or Esc, closes the open list. Registered once.
  if (!closeOnOutside) {
    closeOnOutside = (event) => {
      if (!openPicker) return;
      // A click inside a list has its own handler (the old element it started on is gone after render()).
      if (event instanceof KeyboardEvent ? event.key !== "Escape" : (event.target as Element).closest?.(".mod-picker")) return;
      setOpen("");
    };
    document.addEventListener("click", closeOnOutside);
    document.addEventListener("keydown", closeOnOutside);
  }
}
