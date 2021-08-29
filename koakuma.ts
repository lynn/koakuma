import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import { Client, Intents, MessageEmbed } from "discord.js";
import { readFileSync } from "fs";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { URL, URLSearchParams } from "url";

const safebooruRoot = "https://safebooru.donmai.us";
const imagesPerGame = 9;
const secondsBetweenImages = 3.0;
const secondsBetweenHints = 30.0;
const gameChannelNames = ["games"];
const topN = 10;
const tieSeconds = 0.5;

const aliases: Record<string, string[]> = require("./aliases.json");
const tags = readFileSync("./tags.txt").toString().trimEnd().split("\n");

function shuffleArray<T>(array: T[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

shuffleArray(tags);

const badRegex = new RegExp(
  "(_|^)(anmv|encrq?|gehgu|fcbvyref|htbven|qenjsnt|shgn(anev)?|j+wbo|pbaqbzf?|oehvfr|theb|ybyv|nohfr|elban|cravf(rf)?|intvany?|nany|frk|(cer)?phz(fubg)?|crargengvba|chffl|betnfz|crr|abbfr|rerpgvba|pebgpu(yrff)?|qrngu|chovp|^choyvp(_hfr|_ahqvgl)?$|sryyngvb|phaavyvathf|znfgheongvba|svatrevat)(_|$)".replace(
    /[a-z]/g,
    (m) => String.fromCharCode(((m.charCodeAt(0) + 20) % 26) + 97)
  )
);

function isBad(tag: string): boolean {
  return badRegex.test(tag);
}

function isUnguessable(tag: string): boolean {
  return ["one-hour_drawing_challenge", "doujinshi", "original"].includes(tag);
}

function isKancolle(tag: string): boolean {
  return /kantai_collection|kancolle/.test(tag);
}

/**
 * Clean up underscores and parenthesis from a tag-ish input string.
 * ```
 * normalize("alice_margatroid_(pc-98)") == normalize(" Alice  Margatroid\n") == "alice margatroid"
 * normalize("shimakaze_(kantai_collection)_(cosplay)") == "shimakaze"
 * ```
 */
function normalize(s: string): string {
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
function alnums(s: string): string {
  return s.replace(/\W|_/g, "");
}

async function tagWikiEmbed(tag: string): Promise<MessageEmbed | undefined> {
  const wikiUrl = safebooruRoot + "/wiki_pages/" + tag;
  const body = await (await fetch(wikiUrl)).buffer();
  const document = new JSDOM(body).window.document;

  // Find the first classless <p> tag that *directly* has Latin text in it.
  const paragraph = [...document.querySelectorAll("#wiki-page-body>p")].find(
    (p) => p.className === "" && /[a-zA-Z]/.test(p.textContent ?? "")
  );
  if (!paragraph || !paragraph.textContent) return undefined;

  // Gotcha! Now strip parentheticals; they're mostly just Japanese names.
  const description = paragraph.textContent.replace(/\s*\([^)]*\)/g, "");
  console.log(description);
  return new MessageEmbed({
    title: tag.replace(/_/g, " "),
    url: wikiUrl,
    description,
  });
}

interface Image {
  tag_string: string;
  tag_string_artist?: string;
  pixiv_id?: string;
  id: string;
  source?: string;
  large_file_url: string;
  is_deleted: boolean;
}

async function getImages(
  amount: number,
  tag: string
): Promise<Image[] | undefined> {
  const ids = new Set();
  const images: Image[] = [];
  for (let retry = 0; retry < 3; retry++) {
    try {
      let url = new URL(safebooruRoot + "/posts.json");
      url.searchParams.set("limit", "50");
      url.searchParams.set("random", "true");
      url.searchParams.set("tags", tag);
      const result = await fetch(url);
      const candidates = (await result.json()) as Image[];
      for (const candidate of candidates) {
        if (!candidate["large_file_url"]) continue;
        if (candidate["is_deleted"]) continue;
        if (candidate["tag_string"].split(" ").some(isBad)) continue;
        if (candidate["large_file_url"].endsWith(".swf")) continue;
        if (candidate["id"] in ids) continue;
        ids.add(candidate["id"]);
        images.push(candidate);
        if (images.length >= amount) return images;
      }
    } catch (e) {
      console.log("Connection error. Retrying.", e);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log("Ran out of tries, the given tag must not have many images...");
  return undefined;
}

function credit(image: Image) {
  const artist = (image["tag_string_artist"] ?? "unknown")
    .replace(/\s/g, ", ")
    .replace(/_/g, " ");
  const pixiv = image["pixiv_id"];
  const source = pixiv
    ? `https://www.pixiv.net/artworks/${pixiv}`
    : image["source"];
  const sourceLink = source ? `<${source}>\n` : "";
  return `<${safebooruRoot}/posts/${image["id"]}> by **${artist}**\n${sourceLink}${image["large_file_url"]}`;
}

//////

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`No environment variable ${key} set.`);
  return value;
}

const clientId = env("KOAKUMA_CLIENT_ID");
const guildId = env("KOAKUMA_GUILD");
const commandRoute = Routes.applicationGuildCommands(clientId, guildId);
const commands = [
  {
    name: "ping",
    description: "Replies with Pong!",
  },
];

const koakumaToken = env("KOAKUMA_TOKEN");
const rest = new REST({ version: "9" }).setToken(koakumaToken);
rest.put(commandRoute, { body: commands });

const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS],
});

client.on("ready", () => {
  console.log(`Logged in as ${client?.user?.tag}! Loaded ${tags.length} tags.`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "ping") {
    const images = await getImages(1, "cat");
    await interaction.reply(
      "Pong! " + (images ? images[0].large_file_url : "Uhhhhh")
    );
  }
});

client.login(koakumaToken);
