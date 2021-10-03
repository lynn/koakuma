import { Guild, MessageEmbed } from "discord.js";
import { gameChannelNames, safebooruRoot } from "./constants";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { BooruImage } from "./types";

const badRegex = new RegExp(
  "(_|^)(anmv|encrq?|gehgu|fcbvyref|htbven|qenjsnt|shgn(anev)?|j+wbo|pbaqbzf?|oehvfr|theb|ybyv|nohfr|elban|cravf(rf)?|intvany?|nany|frk|(cer)?phz(fubg)?|crargengvba|chffl|betnfz|crr|abbfr|rerpgvba|pebgpu(yrff)?|qrngu|chovp|^choyvp(_hfr|_ahqvgl)?$|sryyngvb|phaavyvathf|znfgheongvba|svatrevat)(_|$)".replace(
    /[a-z]/g,
    (m) => String.fromCharCode(((m.charCodeAt(0) + 20) % 26) + 97)
  )
);

export function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`No environment variable ${key} set.`);
  return value;
}

export function shuffleArray<T>(array: T[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

export function mono(s: string): string {
  return "**`" + s.replace(/`/g, "") + "`**";
}

export async function sleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 * seconds));
}

export function isBad(tag: string): boolean {
  return badRegex.test(tag);
}

export function isUnguessable(tag: string): boolean {
  return ["one-hour_drawing_challenge", "doujinshi", "original"].includes(tag);
}

export function isKancolle(tag: string): boolean {
  return /kantai_collection|kancolle/.test(tag);
}

/**
 * Clean up underscores and parenthesis from a tag-ish input string.
 * ```
 * normalize("alice_margatroid_(pc-98)") == normalize(" Alice  Margatroid\n") == "alice margatroid"
 * normalize("shimakaze_(kantai_collection)_(cosplay)") == "shimakaze"
 * ```
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(\s*\([^)]+\))*$/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/**
 * Return only the alphanumeric characters of a string.
 * This is used to compare guesses and answers, so that "catgirl" == "cat-girl" == "cat girl" == "catgirl?".
 */
export function alnums(s: string): string {
  return s.replace(/\W|_/g, "").toLowerCase();
}

/**
 * Make a string like `Reimu, Marisa, and Sanae`.
 */
export function commatize(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  } else {
    return names.join(", ").replace(/(.*), /, "$1 and ");
  }
}

export async function tagWikiEmbed(
  tag: string
): Promise<MessageEmbed | undefined> {
  const wikiUrl = safebooruRoot + "/wiki_pages/" + tag;
  const body = await (await fetch(wikiUrl)).buffer();
  const document = new JSDOM(body).window.document;

  // Find the first classless <p> tag that *directly* has Latin text in it.
  const paragraph = [...document.querySelectorAll("#wiki-page-body>p")].find(
    (p) =>
      p.className === "" &&
      [...p.childNodes].some(
        (x) => x.nodeType === 3 && /[a-z]/i.test(x.textContent ?? "")
      )
  );
  if (!paragraph || !paragraph.textContent) return undefined;

  // Gotcha! Now strip parentheticals; they're mostly just Japanese names.
  const description = paragraph.textContent.replace(/\s*\([^)]*\)/g, "");
  return new MessageEmbed({
    title: tag.replace(/_/g, " "),
    url: wikiUrl,
    description,
  });
}

export function creditEmbed(image: BooruImage): MessageEmbed {
  const characters = commatize(
    (image.tag_string_character || image.tag_string_copyright || "artwork")
      .split(" ")
      .slice(0, 2)
      .map((x) => x.replace(/_/g, " "))
  );
  const artist = commatize(
    (image.tag_string_artist || "unknown artist")
      .split(" ")
      .map((x) => x.replace(/_/g, " "))
  );
  const pixiv = image.pixiv_id;
  const source = pixiv
    ? `https://www.pixiv.net/artworks/${pixiv}`
    : image.source || "unknown";
  const match = source.match(/https?:\/\/(www\.)?([^/]+)/);
  return new MessageEmbed({
    title: `${characters} :art: ${artist}`.trim(),
    url: `${safebooruRoot}/posts/${image.id}`,
    image: { url: image.large_file_url, height: 500 },
    fields: [
      {
        name: "Source",
        value: match ? `[${source}](${source})` : source,
        inline: true,
      },
    ],
  });
}

export async function gameChannelSuggestion(guild: Guild): Promise<string> {
  const channels = await guild.channels.fetch();
  let mentions = [];
  for (const c of channels.values()) {
    if (c.isText() && gameChannelNames.includes(c.name))
      mentions.push(`<#${c.id}>`);
  }
  return "Let's play somewhere else: " + mentions.join(" ");
}

function isDisqualified(image: BooruImage): boolean {
  if (!image.large_file_url) return true;
  if (image.is_banned) return true;
  if (image.is_deleted) return true;
  if (image.large_file_url.endsWith(".swf")) return true;
  if (image.tag_string.split(" ").some(isBad)) return true;
  return false;
}

export async function getImages(
  amount: number,
  tag: string
): Promise<BooruImage[] | undefined> {
  const ids = new Set();
  const images: BooruImage[] = [];
  for (let retry = 0; retry < 3; retry++) {
    try {
      let url = new URL(safebooruRoot + "/posts.json");
      url.searchParams.set("limit", "100");
      url.searchParams.set("tags", tag);
      const result = await fetch(url);
      const candidates = (await result.json()) as BooruImage[];
      if (!Array.isArray(candidates)) {
        console.log("candidates not an array?", url);
        continue;
      }
      shuffleArray(candidates);
      for (const candidate of candidates) {
        if (isDisqualified(candidate) || ids.has(candidate.id)) continue;
        ids.add(candidate.id);
        images.push(candidate);
        if (images.length >= amount) return images;
      }
    } catch (e) {
      console.log("Connection error. Retrying.", e);
    }
    await sleep(0.2);
  }
  console.log(`Ran out of tries, ${tag} must not have many images...`);
  return undefined;
}
