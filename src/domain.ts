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

export function isCurrentCatalogCampaign(campaign: Campaign, inspection: Inspection | null) {
  if (inspection?.managedCampaigns.some((item) => item.id === campaign.id)) return true;
  const current = inspection?.activeCampaigns.find((item) => item.slot === campaignSlot(campaign.requirements.campaign));
  return Boolean(current && current.title.trim().toLocaleLowerCase() === campaign.title.trim().toLocaleLowerCase() && current.version.trim() === campaign.version.trim());
}
