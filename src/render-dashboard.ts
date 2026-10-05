import type { Campaign, Catalog, Inspection, SavedCampaignResume } from "./types";
import { campaignSlot, formatBytes, isCommunityCampaign } from "./domain";
import { resumeCheckpoint, resumeFor, resumeInstruction, resumeSummary, sortCampaignsByRecentPlay } from "./resume";
// The game's own emblems, extracted from StarCraft II: the expansion icons, and the
// Nova Covert Ops decal (NCO has no expansion icon).
import wingsLogo from "./assets/campaigns/wings-of-liberty.png";
import swarmLogo from "./assets/campaigns/heart-of-the-swarm.png";
import voidLogo from "./assets/campaigns/legacy-of-the-void.png";
import novaLogo from "./assets/campaigns/nova-covert-ops.png";

const slots = [
  { id: "wings-of-liberty", title: "Wings of Liberty", short: "WOL", logo: wingsLogo },
  { id: "heart-of-the-swarm", title: "Heart of the Swarm", short: "HOTS", logo: swarmLogo },
  { id: "legacy-of-the-void", title: "Legacy of the Void", short: "LOTV", logo: voidLogo },
  { id: "nova-covert-ops", title: "Nova Covert Ops", short: "NCO", logo: novaLogo },
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
  // An unmodified slot is Blizzard's campaign; say so instead of the backend's "untracked" wording.
  const currentTitle = !current ? "Unknown" : current.isModified ? current.title : `Original ${slot.title}`;
  const currentMeta = !current ? "" : current.isModified ? `Version ${current.version}` : "Blizzard";
  const managed = context.inspection?.managedCampaigns.find((campaign) => campaign.slot === slot.id);
  const activeResume = managed ? resumeFor(context.savedResumes, managed.id) : null;

  return `
    <article class="campaign-slot faction-${slot.id}">
      <header class="slot-header">
        <img class="slot-sigil" src="${slot.logo}" alt="">
        <div><p class="eyebrow">${slot.short}</p><h2>${slot.title}</h2></div>
        ${current ? `<span class="slot-state ${current.isModified ? "custom" : "original"}">${current.isModified ? "Custom" : "Original"}</span>` : ""}
      </header>
      <section class="current-install">
        <div class="current-campaign-copy"><small>PLAYING NOW</small><strong>${escapeHtml(currentTitle)}</strong>${currentMeta ? `<span>${escapeHtml(currentMeta)}</span>` : ""}${activeResume?.latestSave ? `<div class="resume-instruction"><strong>Continue from ${escapeHtml(resumeCheckpoint(activeResume) ?? "your last save")}</strong><span>${escapeHtml(resumeInstruction(activeResume.latestSave))}</span></div>` : ""}</div>
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
