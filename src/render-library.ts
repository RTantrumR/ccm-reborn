import type { Campaign, Catalog, CurrentCampaign, Inspection } from "./types";
import { campaignSlot, formatBytes, isCommunityCampaign } from "./domain";
import { renderGallery } from "./gallery";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
);

// Catalog tags are only [base campaign, "CCM package"] today, which repeats the
// Campaign cell. Hidden until the catalog carries tags worth showing.
const SHOW_TAGS = false;

const FILTERS = [
  { id: "", label: "All" },
  { id: "wings-of-liberty", label: "Wings of Liberty" },
  { id: "heart-of-the-swarm", label: "Heart of the Swarm" },
  { id: "legacy-of-the-void", label: "Legacy of the Void" },
  { id: "nova-covert-ops", label: "Nova Covert Ops" },
];

export type LibraryContext = {
  catalog: Catalog | null;
  // Campaign Archive mods, listed after the catalog.
  archive: Campaign[];
  inspection: Inspection | null;
  selectedId: string;
  filter: string; // campaignSlot() id, or "" for every campaign
  busy: boolean;
  gameDir: string;
  profileDir: string;
  installingCampaignId: string;
  isCurrentCatalogCampaign: (campaign: Campaign) => boolean;
};

const HOSTS: [RegExp, string][] = [
  [/(^|.)mega.(nz|io|co.nz)$/i, "MEGA"], [/^drive.google.com$|^docs.google.com$/i, "Google Drive"],
  [/(^|.)dropbox.com$/i, "Dropbox"], [/(^|.)mediafire.com$/i, "MediaFire"], [/(^|.)moddb.com$/i, "ModDB"],
  [/^1drv.ms$|^onedrive.live.com$/i, "OneDrive"],
];

function hostName(url: string) {
  try {
    const host = new URL(url).hostname;
    return HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^www./, "");
  } catch {
    return "";
  }
}

// Links in a description open in the browser. Only https ones: the same rule as open_web_link.
const LINK = /https:\/\/[^\s<>()\]]+/g;

function linkedText(text: string) {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    // A sentence's closing punctuation isn't part of the link.
    const url = match[0].replace(/[.,;:!?'"]+$/, "");
    html += `${escapeHtml(text.slice(last, match.index))}<button class="text-link" data-action="open-link" data-url="${escapeHtml(url)}">${escapeHtml(url)}</button>`;
    last = match.index + url.length;
  }
  return html + escapeHtml(text.slice(last));
}

// An archive mod is downloaded from its author’s page in the browser.
function renderLinkRow(link: NonNullable<Campaign["link"]>) {
  const host = hostName(link.download);
  return `<div class="install-row">
    <button class="primary install" data-action="open-link" data-url="${escapeHtml(link.download)}">${host ? `Download from ${escapeHtml(host)}` : "Download"}</button>
    ${link.docs ? `<button class="ghost" data-action="open-link" data-url="${escapeHtml(link.docs)}">Patch notes</button>` : ""}
  </div>`;
}

function renderInstallRow(campaign: Campaign, context: LibraryContext) {
  if (campaign.link) return renderLinkRow(campaign.link);
  const working = context.busy && context.installingCampaignId === campaign.id;
  const disabled = !context.gameDir ? 'disabled title="Choose your StarCraft II folder first"'
    : !context.profileDir ? 'disabled title="Choose your StarCraft II account first"'
    : context.busy ? "disabled" : "";
  const button = context.isCurrentCatalogCampaign(campaign)
    ? `<button class="ghost" data-action="install" data-campaign="${escapeHtml(campaign.id)}" ${disabled}>${working ? "Working…" : "Repair installation"}</button>`
    : `<button class="primary install" data-action="install" data-campaign="${escapeHtml(campaign.id)}" ${disabled}>${working ? "Working…" : `Install v${escapeHtml(campaign.version)}`}</button>`;
  return `<div class="install-row">${button}</div>`;
}

function renderLibraryDetail(campaign: Campaign, context: LibraryContext) {
  const slot = campaignSlot(campaign.requirements.campaign);
  const current = context.inspection?.activeCampaigns.find((item: CurrentCampaign) => item.slot === slot);
  const tags = SHOW_TAGS ? `<div class="tags">${campaign.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : "";
  return `
    ${renderGallery(campaign)}
    <div class="detail-head">
      <p class="eyebrow">${escapeHtml(campaign.requirements.campaign)}</p>
      <div class="title-row"><h2>${escapeHtml(campaign.title)}</h2>${campaign.version ? `<span class="version">v${escapeHtml(campaign.version)}</span>` : ""}</div>
      <p class="byline">${escapeHtml(campaign.author)}</p>
    </div>
    <div class="detail-body">
      <p class="description">${linkedText(campaign.description)}</p>
      <div class="metadata${campaign.link ? " single" : ""}">
        ${campaign.link ? "" : `<div><small>SIZE</small><strong>${formatBytes(campaign.package.size)}</strong></div>`}
        <div><small>CAMPAIGN</small><strong>${escapeHtml(campaign.requirements.campaign)}</strong></div>
      </div>
      ${tags}
      ${current ? `<section class="current-campaign"><div><small>CURRENT ${escapeHtml(campaign.requirements.campaign.toUpperCase())}</small><strong>${escapeHtml(current.title)}</strong><span>${escapeHtml(current.author)} · ${escapeHtml(current.version)}</span></div></section>` : ""}
      ${renderInstallRow(campaign, context)}
    </div>`;
}

function renderCard(campaign: Campaign, selected: Campaign | null, context: LibraryContext) {
  const classes = ["campaign-card", `faction-${campaignSlot(campaign.requirements.campaign)}`, campaign.id === selected?.id ? "selected" : ""].join(" ").trim();
  return `<button class="${classes}" data-library-campaign="${escapeHtml(campaign.id)}">
    <div class="campaign-copy"><h2>${escapeHtml(campaign.title)}</h2><p>${escapeHtml(campaign.author)}${campaign.version ? ` · v${escapeHtml(campaign.version)}` : ""}</p></div>
    ${context.isCurrentCatalogCampaign(campaign) ? '<span class="installed">CURRENT</span>' : ""}
  </button>`;
}

function renderFilters(active: string) {
  return `<div class="library-filters" role="toolbar" aria-label="Campaign">${FILTERS.map((filter) =>
    `<button class="filter-chip${filter.id ? ` faction-${filter.id}` : ""}${filter.id === active ? " active" : ""}" data-page="library" data-library-filter="${filter.id}" aria-pressed="${filter.id === active}">${filter.label}</button>`).join("")}</div>`;
}

export function renderLibrary(context: LibraryContext) {
  const campaigns = [...(context.catalog?.campaigns ?? []), ...context.archive].filter((campaign) => isCommunityCampaign(campaign)
    && (!context.filter || campaignSlot(campaign.requirements.campaign) === context.filter));
  // The selection follows the filter: a pick outside it falls back to the first visible one.
  const selected = campaigns.find((campaign) => campaign.id === context.selectedId) ?? campaigns[0] ?? null;
  const list = campaigns.length
    ? campaigns.map((campaign) => renderCard(campaign, selected, context)).join("")
    : '<div class="empty-list">No campaigns in this catalog yet.</div>';
  const detail = selected
    ? `<article class="campaign-detail faction-${campaignSlot(selected.requirements.campaign)}">${renderLibraryDetail(selected, context)}</article>`
    : '<article class="campaign-detail"><div class="empty-detail"><div class="empty-orb">◇</div><h2>Library is empty.</h2></div></article>';
  return `${renderFilters(context.filter)}<section class="workspace library-workspace"><div class="campaign-list">${list}</div>${detail}</section>`;
}
