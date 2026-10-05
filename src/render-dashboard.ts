import type { Campaign, Catalog, Inspection, SavedCampaignResume } from "./types";
import { campaignSlot, formatBytes, isCommunityCampaign } from "./domain";
import { resumeCheckpoint, resumeFor, resumeInstruction, resumeSummary, sortCampaignsByRecentPlay } from "./resume";

const slots = [
  { id: "wings-of-liberty", title: "Wings of Liberty", short: "WOL" },
  { id: "heart-of-the-swarm", title: "Heart of the Swarm", short: "HOTS" },
  { id: "legacy-of-the-void", title: "Legacy of the Void", short: "LOTV" },
  { id: "nova-covert-ops", title: "Nova Covert Ops", short: "NCO" },
] as const;

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// The Campaigns page previews what each campaign offers; the Library lists it all.
const PREVIEW_COUNT = 5;

type DashboardContext = {
  catalog: Catalog | null;
  inspection: Inspection | null;
  savedResumes: SavedCampaignResume[];
  busy: boolean;
  gameDir: string;
  profileDir: string;
  isCurrentCatalogCampaign: (campaign: Campaign) => boolean;
};

export function renderDashboard(context: DashboardContext) {
  return `<section class="campaign-dashboard">${slots.map((slot) => renderSlot(slot, context)).join("")}</section>`;
}

function renderSlot(slot: typeof slots[number], context: DashboardContext) {
  const current = context.inspection?.activeCampaigns.find((campaign) => campaign.slot === slot.id);
  const options = sortCampaignsByRecentPlay(
    context.catalog?.campaigns.filter((campaign) => isCommunityCampaign(campaign) && campaignSlot(campaign.requirements.campaign) === slot.id) ?? [],
    context.savedResumes,
  );
  const currentPackage = context.catalog?.campaigns.find((campaign) =>
    campaignSlot(campaign.requirements.campaign) === slot.id && context.isCurrentCatalogCampaign(campaign)
  );
  const currentTitle = current?.title ?? "Unknown";
  const currentMeta = current ? `Version ${current.version}` : "";
  const managed = context.inspection?.managedCampaigns.find((campaign) => campaign.slot === slot.id);
  const activeResume = managed ? resumeFor(context.savedResumes, managed.id) : null;

  return `
    <article class="campaign-slot faction-${slot.id}">
      <header class="slot-header">
        <div class="slot-sigil">${slot.short.slice(0, 1)}</div>
        <div><p class="eyebrow">${slot.short}</p><h2>${slot.title}</h2></div>
        ${current ? `<span class="slot-state ${current.isModified ? "custom" : "original"}">${current.isModified ? "Custom" : "Original"}</span>` : ""}
      </header>
      <section class="current-install">
        <div class="current-campaign-copy"><small>PLAYING NOW</small><strong>${escapeHtml(currentTitle)}</strong>${currentMeta ? `<span>${escapeHtml(currentMeta)}</span>` : ""}${managed ? `<div class="resume-instruction"><strong>${activeResume?.latestSave ? `Continue from ${escapeHtml(resumeCheckpoint(activeResume) ?? "your last save")}` : "Ready to start"}</strong><span>${escapeHtml(resumeInstruction(activeResume))}</span></div>` : ""}</div>
        <div class="current-slot-actions"><button class="primary compact open-battle-net" data-action="open-battle-net" ${context.busy ? "disabled" : ""}>Open Battle.net</button>${currentPackage || managed ? `<details class="campaign-options"><summary>More</summary><div>${currentPackage ? `<button class="ghost repair" data-action="install" data-campaign="${escapeHtml(currentPackage.id)}" ${!context.gameDir || !context.profileDir || context.busy ? "disabled" : ""}>Repair files</button>` : ""}${managed ? `<button class="ghost repair" data-action="restore" data-target="${escapeHtml(managed.targetPath)}" ${!context.gameDir || context.busy || !context.profileDir ? "disabled" : ""}>Restore original</button>` : ""}</div></details>` : ""}</div>
      </section>
      <section class="alternatives">
        <div class="alternative-heading"><small>MODS</small>${options.length > PREVIEW_COUNT ? `<button class="see-all" data-page="library" data-library-filter="${slot.id}">See all</button>` : ""}</div>
        ${options.length ? options.slice(0, PREVIEW_COUNT).map((campaign) => renderPreview(campaign, slot.id, context)).join("") : '<p class="no-options">No mods for this campaign yet. Check for updates, or add one from your computer.</p>'}
      </section>
    </article>`;
}

function renderPreview(campaign: Campaign, slotId: string, context: DashboardContext) {
  const progress = resumeSummary(resumeFor(context.savedResumes, campaign.id));
  return `
    <article class="install-option">
      <div class="option-copy"><strong><span class="option-title">${escapeHtml(campaign.title)}</span>${context.isCurrentCatalogCampaign(campaign) ? '<span class="installed">CURRENT</span>' : ""}</strong><span>${escapeHtml(campaign.author)} · v${escapeHtml(campaign.version)} · ${formatBytes(campaign.package.size)}</span>${progress ? `<span class="option-progress">${escapeHtml(progress)}</span>` : ""}</div>
      <button class="ghost compact" data-page="library" data-library-filter="${slotId}" data-select="${escapeHtml(campaign.id)}">View</button>
    </article>`;
}
