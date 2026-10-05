import { invoke } from "@tauri-apps/api/core";
import type { Campaign, Catalog, Inspection } from "./types";
import { campaignSlot } from "./domain";

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
};

function collectEntries(catalog: Catalog | null): Entry[] {
  const known = new Map((catalog?.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const entries: Entry[] = installed.map((record) => {
    const campaign = known.get(record.campaignId);
    return {
      id: record.campaignId, title: campaign?.title ?? record.title, author: campaign?.author ?? record.author,
      version: campaign?.version ?? record.version, slot: campaignSlot(record.campaign), installedAt: record.installedAt,
      isLocal: Boolean(campaign?.isLocal), isCcm: Boolean(campaign?.isCcm), installable: Boolean(campaign || record.cachedArchive),
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
    });
  }
  return entries;
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

const versioned = (title: string, version: string) => [title, version ? `v${version}` : ""].filter(Boolean).join(" · ");

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

function renderSwitcher(slot: typeof SLOTS[number], playing: { id: string; modified: boolean }, entries: Entry[], context: MyModsContext) {
  const disabled = !context.gameDir ? 'disabled title="Choose your StarCraft II folder first"'
    : !context.profileDir ? 'disabled title="Choose your StarCraft II account first"'
    : context.busy ? "disabled" : "";
  const unknownMod = playing.modified && !playing.id;
  const sorted = [...entries].sort((left, right) => left.title.localeCompare(right.title) || right.version.localeCompare(left.version));
  const options = [
    // Back to Blizzard's campaign is safe only when the current mod is recoverable.
    `<option value="original" ${playing.modified ? "" : "selected"} ${unknownMod ? "disabled" : ""}>Original ${slot.title}</option>`,
    unknownMod ? '<option value="" selected disabled>A mod that is not in your list</option>' : "",
    ...sorted.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === playing.id ? "selected" : ""} ${entry.installable ? "" : "disabled"}>${escapeHtml(versioned(entry.title, entry.version))}${entry.installable ? "" : " (no longer available)"}</option>`),
  ].join("");
  return `<label class="mymods-switch"><span>Switch to</span><select class="mod-switcher" data-switch-target="${slot.targetPath}" ${disabled}>${options}</select></label>`;
}

function renderAdded(entries: Entry[], context: MyModsContext) {
  const added = entries.filter((entry) => entry.isLocal);
  if (!added.length) return "";
  return `<details class="mymods-added"><summary>Added from your computer</summary>${added.map((entry) => `
    <div><span>${escapeHtml(versioned(entry.title, entry.version))}</span><button type="button" class="link-action" data-action="remove-local-mod" data-campaign="${escapeHtml(entry.id)}" ${context.busy ? "disabled" : ""}>Remove from list</button></div>`).join("")}</details>`;
}

function renderGroup(slot: typeof SLOTS[number], entries: Entry[], context: MyModsContext) {
  const playing = playingIn(slot, entries, context);
  return `<article class="mymods-group faction-${slot.id}">
    <p class="eyebrow">${slot.title}</p>
    ${renderCurrent(slot, playing, entries, context)}
    ${renderSwitcher(slot, playing, entries, context)}
    ${renderAdded(entries, context)}
  </article>`;
}

/// One card per base campaign, so all four fit on one screen however many mods
/// there are: what is playing, and a dropdown to switch.
export function renderMyMods(context: MyModsContext) {
  const entries = collectEntries(context.catalog);
  return `<section class="mymods">${SLOTS.map((slot) =>
    renderGroup(slot, entries.filter((entry) => entry.slot === slot.id), context)).join("")}</section>`;
}

/// Picking a mod (or "Original") asks once, then switches. Cancelling re-renders,
/// which puts the dropdown back on the current mod.
export function bindMyMods(onPick: (targetPath: string, value: string) => void) {
  document.querySelectorAll<HTMLSelectElement>("select[data-switch-target]").forEach((select) => {
    select.addEventListener("change", () => onPick(select.dataset.switchTarget ?? "", select.value));
  });
}
