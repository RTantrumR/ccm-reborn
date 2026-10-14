import type { Campaign } from "./types";

// The Library's search: a mod's title, its author and its description. Words may come in any
// order and match a word's start; a word of 4+ letters may be off by length/3 letters (the
// hsbg.cards rule), but only against titles and authors: a description matches whole words. Rank: title, then author, then
// description, then words spread over several of them; within each, exact > starts with >
// every word starts a word > anywhere. Typo matches come after every direct match. Equal
// ranks keep the Library's sort order. The search lives until the app closes.

let query = "";

export const libraryQuery = () => query;
export const setLibraryQuery = (value: string) => { query = value; };

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const squash = (text: string) => words(text).join("");
// Word boundaries kept, so a phrase can be looked for as whole words.
const spaced = (text: string) => ` ${words(text).join(" ")} `;

export function levenshtein(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] : 1 + Math.min(previous[j], row[j - 1], previous[j - 1]);
    }
    previous = row;
  }
  return previous[b.length];
}

const typoLimit = (word: string) => Math.floor(word.length / 3);

/** The fewest letters `word` is off from the field: the whole field, one of its words, or the
    start of a longer word ("kerigan" ≈ "kerrigan", "contingancy" ≈ "contingency"). */
function typoDistance(word: string, field: string) {
  const limit = typoLimit(word);
  let best = Infinity;
  for (const candidate of [squash(field), ...words(field)]) {
    if (Math.abs(candidate.length - word.length) <= limit) best = Math.min(best, levenshtein(word, candidate));
    for (let length = Math.max(3, word.length - 1); length <= Math.min(word.length + 2, candidate.length - 1); length++) {
      best = Math.min(best, levenshtein(word, candidate.slice(0, length)));
    }
  }
  return best;
}

/** How well the whole query matches one field: 4 exact, 3 starts with, 2 every word starts
    a word, 1 anywhere, 0 not at all. */
function phraseTier(text: string, field: string, exactOnly: boolean) {
  const wanted = squash(text);
  const have = squash(field);
  if (!wanted || !have) return 0;
  if (exactOnly) return spaced(field).includes(spaced(text)) ? 1 : 0;
  if (have === wanted) return 4;
  if (have.startsWith(wanted)) return 3;
  const fieldWords = words(field);
  if (words(text).every((word) => fieldWords.some((own) => own.startsWith(word)))) return 2;
  return have.includes(wanted) ? 1 : 0;
}

export type SearchHit = { campaign: Campaign; score: number; typo: boolean };

const TITLE = 4000, AUTHOR = 3000, DESCRIPTION = 2000, SPREAD = 1000;

/** The mod's rank for the query, or null when it doesn't match. */
export function scoreMod(campaign: Campaign, text: string): SearchHit | null {
  const title = phraseTier(text, campaign.title, false);
  if (title) return { campaign, score: TITLE + title, typo: false };
  const author = phraseTier(text, campaign.author, false);
  if (author) return { campaign, score: AUTHOR + author, typo: false };
  if (phraseTier(text, campaign.description, true)) return { campaign, score: DESCRIPTION, typo: false };
  const queryWords = words(text);
  if (!queryWords.length) return null;
  const direct = (word: string) => [campaign.title, campaign.author].some((field) => squash(field).includes(word))
    || spaced(campaign.description).includes(` ${word} `);
  if (queryWords.every(direct)) return { campaign, score: SPREAD, typo: false };
  let distance = 0;
  for (const word of queryWords) {
    if (direct(word)) continue;
    if (word.length < 4) return null;
    const best = Math.min(typoDistance(word, campaign.title), typoDistance(word, campaign.author));
    if (best > typoLimit(word)) return null;
    distance += best;
  }
  return { campaign, score: Math.max(1, 999 - distance * 100), typo: true };
}

/** The mods matching the query, best first; `campaigns` comes in the Library's sort order,
    which equal ranks keep (Array.sort is stable). An empty query keeps every mod. */
export function searchLibrary(campaigns: Campaign[], text: string = query) {
  if (!squash(text)) return { hits: campaigns, typo: false };
  const ranked = campaigns.map((campaign) => scoreMod(campaign, text)).filter((hit): hit is SearchHit => hit !== null)
    .sort((left, right) => right.score - left.score);
  return { hits: ranked.map((hit) => hit.campaign), typo: ranked.some((hit) => hit.typo) };
}

/** The query with the author's name added once: as is into an empty box, after a space
    otherwise, and not at all when the name is already in it. */
export function withAuthor(text: string, author: string) {
  if (!squash(author) || spaced(text).includes(spaced(author))) return text;
  return text.trim() ? `${text.trimEnd()} ${author}` : author;
}

/** The authors whose whole name is in the query, for the pills under the box. */
export function authorsIn(text: string, campaigns: Campaign[]) {
  const have = spaced(text);
  return [...new Set(campaigns.map((campaign) => campaign.author))]
    .filter((author) => squash(author) && have.includes(spaced(author)));
}
