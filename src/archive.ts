import { invoke } from "@tauri-apps/api/core";
import { bindGallery } from "./gallery";
import type { Campaign } from "./types";

// The Campaign Archive feed (the archive bot, kept privately): mods added from Discord posts, with their
// pictures. It runs on the VM; VITE_ARCHIVE_FEED=http://127.0.0.1:8791 points a dev build at a
// local bot. tauri.conf.json's CSP must list it (devCsp lists the local one).
export const ARCHIVE_FEED = import.meta.env.VITE_ARCHIVE_FEED || "https://ccm-reborn-app.hsbg.cards";

type ArchiveMod = {
  id: string; title: string; author: string; campaign: string; version: string | null;
  description: string; downloadUrl: string; docsUrl: string | null; images: string[];
  // Set when the bot downloaded the package and checked the app can install it.
  package: { sha256: string; size: number; fileName: string } | null;
};

const CAMPAIGN_NAMES: Record<string, string> = {
  WOL: "Wings of Liberty", HOTS: "Heart of the Swarm", LOTV: "Legacy of the Void",
  NCO: "Nova Covert Ops", ALL: "All campaigns",
};

let archive: Campaign[] = [];

export const archiveCampaigns = () => archive;

const toCampaign = (mod: ArchiveMod): Campaign => ({
  // The app's campaign ids allow only letters, digits, "-" and "_".
  id: `archive-${mod.id}`,
  title: mod.title,
  author: mod.author,
  version: mod.version ?? "",
  description: mod.description,
  tags: [],
  requirements: { campaign: CAMPAIGN_NAMES[mod.campaign] ?? mod.campaign },
  // A verified package installs from its link like a catalog download (MEGA links are decrypted on the way).
  package: mod.package ? { source: mod.downloadUrl, sha256: mod.package.sha256, size: mod.package.size } : { source: "", sha256: "", size: 0 },
  link: { download: mod.downloadUrl, docs: mod.docsUrl },
  images: mod.images.slice(0, 5).map((path) => `${ARCHIVE_FEED}${path}`),
});

/** Reloads the archive's mods. When the feed can't be reached the last list stays, and the
    answer says why for the player. */
export async function refreshArchive(): Promise<{ count: number } | { problem: string }> {
  try {
    const response = await fetch(`${ARCHIVE_FEED}/catalog.json`, { signal: AbortSignal.timeout(5000) });
    // The feed's per-address limit.
    if (response.status === 429) return { problem: "The Library was checked many times in a row. Try again in a minute." };
    if (!response.ok) throw new Error(`feed answered ${response.status}`);
    const feed = (await response.json()) as { mods: ArchiveMod[] };
    archive = feed.mods.map(toCampaign);
    return { count: archive.length };
  } catch (error) {
    console.warn("[archive] feed unavailable:", error);
    return { problem: "Couldn't reach the Campaign Archive. Check your internet connection, then press Check for updates." };
  }
}

/** Asks the feed to look again at a mod whose download no longer matches its entry (its
    author put a new file behind the same link), then reloads the archive. Gives the mod's
    entry as it is now, and why it can't be installed when it can't. */
export async function recheckArchiveMod(id: string): Promise<{ campaign: Campaign | null; problem: string | null }> {
  const response = await fetch(`${ARCHIVE_FEED}/recheck/${id.replace(/^archive-/, "")}`, { method: "POST", signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) throw new Error(`feed answered ${response.status}`);
  const result = (await response.json()) as { problem: string | null };
  await refreshArchive();
  return { campaign: archive.find((mod) => mod.id === id) ?? null, problem: result.problem };
}

export function bindArchive(onError: (message: string) => void) {
  bindGallery();
  document.querySelectorAll<HTMLButtonElement>("[data-action='open-link']").forEach((button) =>
    button.addEventListener("click", () => void invoke("open_web_link", { url: button.dataset.url ?? "" }).catch((error) => onError(String(error)))));
}
