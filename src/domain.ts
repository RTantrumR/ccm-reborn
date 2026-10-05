import type { Campaign, Inspection } from "./types";

export function campaignSlot(campaign: string) {
  const value = campaign.toLowerCase();
  // An archive mod made for every campaign (Library filter "All" only).
  if (value === "all campaigns") return "all";
  if (value.includes("wings") || value.includes("liberty") || value.includes("wol")) return "wings-of-liberty";
  if (value.includes("heart") || value.includes("swarm") || value.includes("hots")) return "heart-of-the-swarm";
  if (value.includes("legacy") || value.includes("void") || value.includes("lotv")) return "legacy-of-the-void";
  return "nova-covert-ops";
}

/// The Library and the Campaigns previews list the community catalogue: mods that can be
/// downloaded. Mods already on this PC (added from a zip, or left by the original CCM) live
/// in My Mods only.
export const isCommunityCampaign = (campaign: Campaign) => !campaign.isLocal && !campaign.isCcm;

export const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 * 1024 ? 1 : 0)} MB`;

/// "v1.2", "Alpha 0" as it is, or nothing for a mod without a version.
export function versionTag(version: string | null | undefined) {
  const value = version?.trim() ?? "";
  return /^\d/.test(value) ? `v${value}` : value;
}
/// The parts that exist, joined with " · " (author, version, size…).
export const byline = (...parts: string[]) => parts.filter(Boolean).join(" · ");

/// The mod an install of `id` uses. The Library's entry wins over a copy kept in My Mods
/// under the same id, so an update installs the new file; while both are the same file,
/// the kept copy on disk is used and nothing is downloaded.
export function findCampaign(id: string, catalog: Campaign[], archive: Campaign[]): Campaign | undefined {
  const library = catalog.find((item) => item.id === id && isCommunityCampaign(item)) ?? archive.find((item) => item.id === id);
  const kept = catalog.find((item) => item.id === id && item.isLocal);
  if (library && kept) return kept.package.sha256 === library.package.sha256 ? { ...library, package: kept.package } : library;
  return library ?? catalog.find((item) => item.id === id);
}

export type InstallAction = "install" | "update" | "reinstall";

/// What an Install button does for this mod: the mod in its slot in another version is an
/// update; the same version is a reinstall (put its files back as they were). A mod without
/// a version can't be told newer, so it's a reinstall.
export function installAction(campaign: Campaign, inspection: Inspection | null): InstallAction {
  if (!isCurrentCatalogCampaign(campaign, inspection)) return "install";
  const installed = inspection?.activeCampaigns.find((item) => item.slot === campaignSlot(campaign.requirements.campaign))?.version.trim() ?? "";
  const offered = campaign.version.trim();
  return installed && offered && installed !== offered ? "update" : "reinstall";
}

export function isCurrentCatalogCampaign(campaign: Campaign, inspection: Inspection | null) {
  if (inspection?.managedCampaigns.some((item) => item.id === campaign.id)) return true;
  const current = inspection?.activeCampaigns.find((item) => item.slot === campaignSlot(campaign.requirements.campaign));
  return Boolean(current && current.title.trim().toLocaleLowerCase() === campaign.title.trim().toLocaleLowerCase() && current.version.trim() === campaign.version.trim());
}
