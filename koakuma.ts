import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import {
  Client,
  Intents,
  MessageEmbed,
  TextChannel,
  GuildMember,
  Message,
} from "discord.js";
import { readFileSync } from "fs";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { URL, URLSearchParams } from "url";

const safebooruRoot = "https://safebooru.donmai.us";
// const imagesPerGame = 9;
// const secondsBetweenImages = 3.0;
// const secondsBetweenHints = 30.0;
const imagesPerGame = 2;
const secondsBetweenImages = 2.0;
const secondsBetweenHints = 2.0;
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

function mono(s: string): string {
  return "**`" + s + "`**";
}

shuffleArray(tags);

const badRegex = new RegExp(
  "(_|^)(anmv|encrq?|gehgu|fcbvyref|htbven|qenjsnt|shgn(anev)?|j+wbo|pbaqbzf?|oehvfr|theb|ybyv|nohfr|elban|cravf(rf)?|intvany?|nany|frk|(cer)?phz(fubg)?|crargengvba|chffl|betnfz|crr|abbfr|rerpgvba|pebgpu(yrff)?|qrngu|chovp|^choyvp(_hfr|_ahqvgl)?$|sryyngvb|phaavyvathf|znfgheongvba|svatrevat)(_|$)".replace(
    /[a-z]/g,
    (m) => String.fromCharCode(((m.charCodeAt(0) + 20) % 26) + 97)
  )
);

async function sleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 * seconds));
}

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

interface BooruImage {
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
      shuffleArray(candidates);
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
    await sleep(0.2);
  }
  console.log("Ran out of tries, the given tag must not have many images...");
  return undefined;
}

function credit(image: BooruImage) {
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

let game: Game | undefined = undefined;

interface Manual {
  master: GuildMember;
  tag: string;
  images: BooruImage[];
}

let manualQueue: Manual[] = [];

interface RanManual {
  time: Date;
  channel: TextChannel;
}

let ranManual: Map<GuildMember["id"], RanManual> = new Map();

function recentlyRanManual(
  authorId: GuildMember["id"]
): TextChannel | undefined {
  const rm = ranManual.get(authorId);
  if (!rm) return undefined;
  const tenMinutesAgo = new Date().getTime() - 10 * 60 * 1e3;
  return rm.time.getTime() > tenMinutesAgo ? rm.channel : undefined;
}

class Game {
  static tagIndex: number = 0;
  private winners: GuildMember[] = [];
  private winnerMessage: Message | undefined = undefined;
  private imageMessages: Message[] = [];
  private answer: string;
  private answers: string[];
  private finished: boolean = false;
  private prettyTag: string;

  constructor(
    private channel: TextChannel,
    private tag: string,
    private images: BooruImage[],
    private gameMaster: GuildMember | undefined = undefined
  ) {
    this.prettyTag = tag.replace(/_/g, " ");
    this.answer = normalize(tag);
    this.answers = [this.answer];
    for (const alias of aliases[tag] ?? []) {
      this.answers.push(normalize(alias));
    }
  }

  static async startRandom(
    channel: TextChannel,
    nokc: boolean = false
  ): Promise<Game> {
    let images: BooruImage[] | undefined = undefined;
    let tag: string;
    do {
      tag = tags[Game.tagIndex];
      Game.tagIndex = (Game.tagIndex + 1) % tags.length;
      if (Game.tagIndex === 0) shuffleArray(tags);
      images = await getImages(imagesPerGame, tag);
    } while (images === undefined);
    return new Game(channel, tag, images);
  }

  static startManual(channel: TextChannel, manual: Manual): Game {
    return new Game(channel, manual.tag, manual.images, manual.master);
  }

  async play(): Promise<void> {
    let intro = "Find the common tag between these images:";
    if (this.gameMaster) {
      intro = `This tag was picked by <@${this.gameMaster.user.id}>!\n${intro}`;
    }
    await this.channel.send(intro);
    for (const image of this.images) {
      this.imageMessages.push(await this.channel.send(image.large_file_url));
      await sleep(secondsBetweenImages);
      if (this.finished) return;
    }

    // Slowly unmask the answer.
    const censored = this.answer.replace(/\w/g, "●");
    const lengths = censored.split(/\s+/).map((w) => w.length);
    let mask = [...censored];
    let indices = mask.flatMap((x, i) => (x === "●" ? [i] : []));
    let lengthHint = ` (${lengths.join(", ")})`;
    shuffleArray(indices);
    for (let i = indices.length - 1; i >= 0; i--) {
      if (i < 15 || i % 2 === 0) {
        await this.channel.send(`Hint: ${mono(mask.join(""))}${lengthHint}`);
        lengthHint = "";
        await sleep(secondsBetweenHints);
        if (this.finished) return;
      }
      mask[indices[i]] = this.answer[indices[i]];
    }

    this.reveal(undefined);
  }

  async reveal(member: GuildMember | undefined) {
    if (this.finished) return;

    if (member !== undefined) {
      // Can't win a game twice:
      if (this.winners.includes(member)) return;
      this.winners.push(member);

      // TODO redis
      // # Award points for public games, but not for giving away the answer.
      // if ri and self.channel.guild and member != game.game_master:
      //     # TODO: leaderboards per guild
      //     ri.zincrby('leaderboard', 1, member.id)
    }

    // Format a message about the outcome of the game.

    const realWinners = this.winners.filter((w) => w !== this.gameMaster);
    const namesString = (ms: GuildMember[]) =>
      ms
        .map((m) => m.displayName)
        .join(", ")
        .replace(/(.*), /, "$1 and ");
    const [subjects, verb] =
      realWinners.length > 0
        ? [namesString(realWinners), "got it"]
        : this.winners.length > 0
        ? [namesString(this.winners), "gave it away"]
        : ["Nobody", "got it"];
    const message = `${subjects} ${verb}! The answer was ${mono(
      this.prettyTag
    )}.`;

    if (this.winnerMessage) {
      await this.winnerMessage.edit(message);
    } else {
      const wikiEmbed = await tagWikiEmbed(this.tag);
      this.winnerMessage = await this.channel.send({
        content: message,
        embeds: wikiEmbed ? [wikiEmbed] : [],
      });
      const n = manualQueue.length;
      if (n > 0) {
        const thereAreTags =
          n === 1 ? "There is 1 manual tag" : `There are ${n} manual tags`;
        await this.channel.send(
          thereAreTags +
            " left in the queue! Type `!start` to play the next one, or `!manual` to queue up a tag.\n" +
            "The next tag in the queue was picked by **" +
            manualQueue[0].master.displayName +
            "**."
        );
      } else {
        await this.channel.send(
          "Type `!start` to play another game, or `!manual` to choose a tag for others to guess." +
            (isKancolle(this.tag)
              ? "\n(Tired of ship girls? Try `!start nokc` to play without Kantai Collection tags.)"
              : "")
        );
      }
    }

    for (let i = 0; i < this.images.length; i++) {
      await this.imageMessages[i].edit(credit(this.images[i]));
    }
  }
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
    name: "start",
    description: "Start a game with a random tag.",
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

  if (interaction.commandName === "start") {
    if (interaction.channel?.type !== "GUILD_TEXT") return;
    game = await Game.startRandom(interaction.channel);
    game.play();
    interaction.reply("Starting a random-tag game.");
  }
});

async function processGuess(message: Message): Promise<void> {}

client.on("messageCreate", processGuess);
client.on("messageEdit", processGuess);

client.login(koakumaToken);
