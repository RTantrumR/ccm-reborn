import type { Campaign, Catalog, CurrentCampaign, Inspection } from "./types";
import { campaignSlot, formatBytes } from "./domain";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// Catalog tags are only [base campaign, "CCM package"] today, which repeats the
// Campaign cell. Hidden until the catalog carries tags worth showing.
const SHOW_TAGS = false;

export type LibraryContext = {
  catalog: Catalog | null;
  inspection: Inspection | null;
  selectedId: string;
  busy: boolean;
  gameDir: string;
  installingCampaignId: string;
  isCurrentCatalogCampaign: (campaign: Campaign) => boolean;
};

function renderInstallRow(campaign: Campaign, context: LibraryContext) {
  const working = context.busy && context.installingCampaignId === campaign.id;
  const disabled = !context.gameDir || context.busy ? "disabled" : "";
  const button = context.isCurrentCatalogCampaign(campaign)
    ? `<button class="ghost" data-action="install" data-campaign="${escapeHtml(campaign.id)}" ${disabled}>${working ? "Working…" : "Repair installation"}</button>`
    : `<button class="primary install" data-action="install" data-campaign="${escapeHtml(campaign.id)}" ${disabled}>${working ? "Working…" : `Install v${escapeHtml(campaign.version)}`}</button>`;
  if (context.gameDir) return `<div class="install-row">${button}</div>`;
  return `<div class="install-row">${button}<button class="ghost" data-action="choose-directory">Choose StarCraft II folder…</button></div>
    <p class="install-blocked">Installing needs your StarCraft II folder. Auto-detection didn't find it.</p>`;
}

function renderLibraryDetail(campaign: Campaign, context: LibraryContext) {
  const slot = campaignSlot(campaign.requirements.campaign);
  const current = context.inspection?.activeCampaigns.find((item: CurrentCampaign) => item.slot === slot);
  const tags = SHOW_TAGS ? `<div class="tags">${campaign.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : "";
  return `
    <div class="detail-head">
      <p class="eyebrow">${escapeHtml(campaign.requirements.campaign)}</p>
      <div class="title-row"><h2>${escapeHtml(campaign.title)}</h2><span class="version">v${escapeHtml(campaign.version)}</span></div>
      <p class="byline">${escapeHtml(campaign.author)}</p>
    </div>
    <div class="detail-body">
      <p class="description">${escapeHtml(campaign.description)}</p>
      <div class="metadata">
        <div><small>SIZE</small><strong>${formatBytes(campaign.package.size)}</strong></div>
        <div><small>CAMPAIGN</small><strong>${escapeHtml(campaign.requirements.campaign)}</strong></div>
      </div>
      ${tags}
      <section class="current-campaign"><div><small>CURRENT ${escapeHtml(campaign.requirements.campaign.toUpperCase())}</small><strong>${current ? escapeHtml(current.title) : "StarCraft II directory not selected"}</strong><span>${current ? `${escapeHtml(current.author)} · ${escapeHtml(current.version)}` : "Auto-detection runs when CCM Reborn starts."}</span></div><button class="ghost open-battle-net" data-action="open-battle-net" ${context.busy ? "disabled" : ""}>Open Battle.net</button></section>
      ${renderInstallRow(campaign, context)}
    </div>`;
}

function renderCard(campaign: Campaign, selected: Campaign | null, context: LibraryContext) {
  const classes = ["campaign-card", `faction-${campaignSlot(campaign.requirements.campaign)}`, campaign.id === selected?.id ? "selected" : ""].join(" ").trim();
  return `<button class="${classes}" data-library-campaign="${escapeHtml(campaign.id)}">
    <div class="campaign-copy"><h2>${escapeHtml(campaign.title)}</h2><p>${escapeHtml(campaign.author)} · v${escapeHtml(campaign.version)}</p></div>
    ${context.isCurrentCatalogCampaign(campaign) ? '<span class="installed">CURRENT</span>' : ""}
  </button>`;
}

export function renderLibrary(context: LibraryContext) {
  const campaigns = context.catalog?.campaigns ?? [];
  const selected = campaigns.find((campaign) => campaign.id === context.selectedId) ?? campaigns[0] ?? null;
  const list = campaigns.length
    ? campaigns.map((campaign) => renderCard(campaign, selected, context)).join("")
    : '<div class="empty-list">No campaigns in this catalog yet.</div>';
  const detail = selected
    ? `<article class="campaign-detail faction-${campaignSlot(selected.requirements.campaign)}">${renderLibraryDetail(selected, context)}</article>`
    : '<article class="campaign-detail"><div class="empty-detail"><div class="empty-orb">◇</div><h2>Library is empty.</h2></div></article>';
  return `<section class="workspace library-workspace"><div class="campaign-list">${list}</div>${detail}</section>`;
}
