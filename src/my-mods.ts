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
  { id: "wings-of-liberty", title: "Wings of Liberty" },
  { id: "heart-of-the-swarm", title: "Heart of the Swarm" },
  { id: "legacy-of-the-void", title: "Legacy of the Void" },
  { id: "nova-covert-ops", title: "Nova Covert Ops" },
];

let installed: InstalledModRecord[] = [];

export async function refreshInstalledMods(gameDir: string) {
  installed = gameDir
    ? await invoke<InstalledModRecord[]>("list_installed_mods", { gameDir }).catch(() => [])
    : [];
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
  installable: boolean;
};

function collectEntries(catalog: Catalog | null): Entry[] {
  const known = new Map((catalog?.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const entries: Entry[] = installed.map((record) => {
    const campaign = known.get(record.campaignId);
    return {
      id: record.campaignId, title: campaign?.title ?? record.title, author: campaign?.author ?? record.author,
      version: campaign?.version ?? record.version, slot: campaignSlot(record.campaign), installedAt: record.installedAt,
      isLocal: Boolean(campaign?.isLocal), installable: Boolean(campaign || record.cachedArchive),
    };
  });
  const listed = new Set(entries.map((entry) => entry.id));
  // Mods added from the player's computer belong here before their first install too.
  for (const campaign of catalog?.campaigns ?? []) {
    if (!campaign.isLocal || listed.has(campaign.id)) continue;
    entries.push({
      id: campaign.id, title: campaign.title, author: campaign.author, version: campaign.version,
      slot: campaignSlot(campaign.requirements.campaign), installedAt: 0, isLocal: true, installable: true,
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
    <div class="option-copy"><strong><span class="option-title">${escapeHtml(entry.title)}</span>${entry.isLocal ? '<span class="local-pill">LOCAL</span>' : ""}${playing ? '<span class="installed">PLAYING</span>' : ""}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ""}${remove ? `<span class="option-remove">${remove}</span>` : ""}</div>
    ${action}
  </div>`;
}

function renderGroup(slot: typeof SLOTS[number], entries: Entry[], context: MyModsContext) {
  const managed = context.inspection?.managedCampaigns.find((campaign) => campaign.slot === slot.id);
  const sorted = [...entries].sort((left, right) =>
    Number(right.id === managed?.id) - Number(left.id === managed?.id)
    || right.installedAt - left.installedAt
    || left.title.localeCompare(right.title));
  // Switching back to Blizzard's campaign is always one of the choices.
  const original = `<div class="mymods-row${managed ? "" : " playing"}">
    <div class="option-copy"><strong><span class="option-title">Original ${slot.title}</span>${managed ? "" : '<span class="installed">PLAYING</span>'}</strong><span>Blizzard</span></div>
    ${managed ? switchButton(`data-action="restore" data-target="${escapeHtml(managed.targetPath)}"`, context) : ""}
  </div>`;
  return `<article class="mymods-group faction-${slot.id}">
    <p class="eyebrow">${slot.title}</p>
    ${sorted.map((entry) => renderRow(entry, entry.id === managed?.id, context)).join("")}
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
