import { Guild, MessageEmbed } from "discord.js";
import { gameChannelNames, safebooruRoot } from "./constants";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { BooruImage } from "./types";

const badRegex = new RegExp(
  "(_|^)(anmv|encrq?|gehgu|erirefr_genc|fcbvyref|htbven|qenjsnt|shgn(anev)?|j+wbo|pbaqbzf?|oehvfr|theb|ybyv|nohfr|elban|cravf(rf)?|intvany?|nany|frk|(cer)?phz(fubg)?|crargengvba|chffl|betnfz|crr|abbfr|rerpgvba|pebgpu(yrff)?|qrngu|chovp|^choyvp(_hfr|_ahqvgl)?$|sryyngvb|phaavyvathf|znfgheongvba|svatrevat|zbyrfgngvba)(_|$)".replace(
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

const boringRegex =
  /uniform$|^(light_|dark_)?(aqua|beige|black|blonde|blue|brown|colored|gold|green|gray|grey|magenta|multicolored|orange|pink|purple|teal|two-tone|red|silver|yellow|white)_/;

export function isBoring(tag: string): boolean {
  return boringRegex.test(tag);
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
  const options = { headers: { "User-Agent": "koakuma" } };
  const response = await fetch(wikiUrl, options);
  const body = await response.buffer();
  const contentType = "text/html;charset=utf-8";
  const document = new JSDOM(body, { contentType }).window.document;

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
    footer: {
      text: document
        .querySelector("#subnav-posts-link")
        ?.textContent?.replace(
          /Posts \((\d+)\)/,
          (_, n) =>
            new Intl.NumberFormat("en-US").format(n) +
            " post" +
            (n === 1 ? "" : "s")
        ),
    },
    description,
  });
}

function fixSource(source: string): string {
  console.log(source);
  const deviant =
    source.match(
      /(?:deviantart|wixmp-ed30a86b8c4ca887773594c2).*.+_by_.+[_-]d([a-z0-9]+)(?:-\w+)?\.(jpe?g|png)/i
    ) ||
    source.match(
      /(?:deviantart|wixmp-ed30a86b8c4ca887773594c2).*d([0-9a-z]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\w+)?\.(jpe?g|png)/i
    );
  return deviant
    ? "https://www.deviantart.com/deviation/" + parseInt(deviant[1], 36)
    : source;
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
    : image.source
    ? fixSource(image.source)
    : "unknown";
  const match = source.match(/https?:\/\/(www\.)?([^/]+)/);
  const link_source = match ? `[${source}](${source})` : source;
  const final_source =
    source.startsWith("https://images-wixmp-") || link_source.length >= 1024
      ? "(see danbooru for source link)"
      : link_source;
  return new MessageEmbed({
    title: `${characters} :art: ${artist}`.trim(),
    url: `${safebooruRoot}/posts/${image.id}`,
    image: { url: image.large_file_url, height: 500 },
    fields: [
      {
        name: "Source",
        value: final_source,
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

const danbooruUser = process.env["KOAKUMA_DANBOORU_USER"];
const danbooruApiKey = process.env["KOAKUMA_DANBOORU_API_KEY"];

export async function getImages(
  amount: number,
  tag: string
): Promise<BooruImage[] | undefined> {
  const ids = new Set();
  const images: BooruImage[] = [];
  for (let retry = 0; retry < 2; retry++) {
    try {
      let url = new URL(safebooruRoot + "/posts.json");
      url.searchParams.set("limit", "100");
      url.searchParams.set("tags", tag);
      if (danbooruUser && danbooruApiKey) {
        url.searchParams.set("login", danbooruUser);
        url.searchParams.set("api_key", danbooruApiKey);
      }
      const options = { headers: { "User-Agent": "koakuma" } };
      const result = await fetch(url, options);
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
      console.log("Connection error.", e);
      return undefined;
    }
    await sleep(1.5);
  }
  console.log(`Ran out of tries, ${tag} must not have many images...`);
  return undefined;
}
