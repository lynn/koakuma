import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import { Client, Intents, MessageEmbed } from "discord.js";
import { readFileSync } from "fs";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";

const safebooruRoot = "https://safebooru.donmai.us";
const imagesPerGame = 9;
const secondsBetweenImages = 3.0;
const secondsBetweenHints = 30.0;
const gameChannelNames = ["games"];
const topN = 10;
const tieSeconds = 0.5;

const aliases: Record<string, string[]> = require("./aliases.json");
const tags = readFileSync("./tags.txt").toString().trimEnd().split("\n");

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
  console.log(`Logged in as ${client?.user?.tag}!`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("Pong!");
  }
});

client.login(koakumaToken);
