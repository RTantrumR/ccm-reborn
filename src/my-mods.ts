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

function switchButton(attributes: string, context: MyModsContext) {
  const disabled = !context.gameDir ? 'disabled title="Choose your StarCraft II folder first"'
    : !context.profileDir ? 'disabled title="Choose your StarCraft II account first"'
    : context.busy ? "disabled" : "";
  return `<button class="primary compact" ${attributes} ${disabled}>Switch</button>`;
}

function renderRow(entry: Entry, playing: boolean, context: MyModsContext) {
  const meta = [entry.author, entry.version ? `v${entry.version}` : ""].filter(Boolean).join(" · ");
  const action = playing ? ""
    : entry.installable ? switchButton(`data-action="install" data-campaign="${escapeHtml(entry.id)}"`, context)
    : '<span class="mymods-gone">No longer available</span>';
  const remove = entry.isLocal
    ? `<button type="button" class="link-action" data-action="remove-local-mod" data-campaign="${escapeHtml(entry.id)}" ${context.busy ? "disabled" : ""}>Remove from list</button>`
    : "";
  return `<div class="mymods-row${playing ? " playing" : ""}">
    <div class="option-copy"><strong><span class="option-title">${escapeHtml(entry.title)}</span>${entry.isLocal ? '<span class="local-pill">LOCAL</span>' : ""}${entry.isCcm ? '<span class="local-pill">CCM</span>' : ""}${playing ? '<span class="installed">PLAYING</span>' : ""}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ""}${remove ? `<span class="option-remove">${remove}</span>` : ""}</div>
    ${action}
  </div>`;
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

function renderGroup(slot: typeof SLOTS[number], entries: Entry[], context: MyModsContext) {
  const playing = playingIn(slot, entries, context);
  const sorted = [...entries].sort((left, right) =>
    Number(right.id === playing.id) - Number(left.id === playing.id)
    || right.installedAt - left.installedAt
    || left.title.localeCompare(right.title));
  // Switching back to Blizzard's campaign is always one of the choices; it can
  // only empty the slot when the current mod is known (and so recoverable).
  const original = `<div class="mymods-row${playing.modified ? "" : " playing"}">
    <div class="option-copy"><strong><span class="option-title">Original ${slot.title}</span>${playing.modified ? "" : '<span class="installed">PLAYING</span>'}</strong><span>Blizzard</span></div>
    ${playing.id ? switchButton(`data-action="restore" data-target="${slot.targetPath}"`, context) : ""}
  </div>`;
  return `<article class="mymods-group faction-${slot.id}">
    <p class="eyebrow">${slot.title}</p>
    ${sorted.map((entry) => renderRow(entry, entry.id === playing.id, context)).join("")}
    ${original}
  </article>`;
}

export function renderMyMods(context: MyModsContext) {
  const entries = collectEntries(context.catalog);
  if (!entries.length) {
    return `<section class="mymods-empty"><h2>No mods yet</h2><p>Mods you install, or add from your computer, show up here so you can switch between them in one click.</p></section>`;
  }
  return `<section class="mymods">${SLOTS
    .map((slot) => ({ slot, items: entries.filter((entry) => entry.slot === slot.id) }))
    .filter((group) => group.items.length)
    .map((group) => renderGroup(group.slot, group.items, context)).join("")}</section>`;
}
