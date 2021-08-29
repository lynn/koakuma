import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import {
  ApplicationCommandData,
  Client,
  Guild,
  GuildMember,
  Intents,
  Message,
  MessageEmbed,
  TextChannel,
} from "discord.js";
import { readFileSync } from "fs";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { URL } from "url";

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

console.log("Loading aliases...");
const aliases: Record<string, string[]> = require("./aliases.json");
let aliasOf: Map<string, string> = new Map();
for (const [k, vs] of Object.entries(aliases)) {
  for (const v of vs) aliasOf.set(v, k);
}

console.log("Loading tags...");
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
  tag_string_artist: string;
  tag_string_character: string;
  tag_string_copyright: string;
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
      if (!Array.isArray(candidates)) {
        console.log("candidates not an array?", url);
        continue;
      }
      shuffleArray(candidates);
      for (const candidate of candidates) {
        if (!candidate.large_file_url) continue;
        if (candidate.is_deleted) continue;
        if (candidate.tag_string.split(" ").some(isBad)) continue;
        if (candidate.large_file_url.endsWith(".swf")) continue;
        if (ids.has(candidate.id)) continue;
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

function commatize(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  } else {
    return names.join(", ").replace(/(.*), /, "$1 and ");
  }
}

function creditEmbed(image: BooruImage): MessageEmbed {
  const characters = commatize(
    (image.tag_string_character || image.tag_string_copyright || "artwork")
      .split(" ")
      .slice(0, 2)
      .map(normalize)
  );
  const artist = commatize(
    (image.tag_string_artist ?? "unknown artist").split(" ").map(normalize)
  );
  const pixiv = image.pixiv_id;
  const source = pixiv
    ? `https://www.pixiv.net/artworks/${pixiv}`
    : image.source ?? "unknown";
  const match = source.match(/https?:\/\/(www\.)?([^/]+)/);
  return new MessageEmbed({
    title: `${characters} by ${artist}`.trim(),
    url: `${safebooruRoot}/posts/${image.id}`,
    image: { url: image.large_file_url, height: 500 },
    fields: [
      {
        name: "Source",
        value: match ? `[${match[2]}](${source})` : source,
        inline: true,
      },
    ],
  });
}

let game: Game | undefined = undefined;

interface Manual {
  master: GuildMember;
  tag: string;
  images: BooruImage[];
}

let manualQueue: Manual[] = [];

class Game {
  static tagIndex: number = 0;
  private winners: GuildMember[] = [];
  private imageMessages: Message[] = [];
  private answer: string;
  private answers: string[];
  public finished: boolean = false;
  private prettyTag: string;

  constructor(
    private channel: TextChannel,
    private tag: string,
    private images: BooruImage[],
    public gameMaster: GuildMember | undefined = undefined
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

  start(): string {
    let intro = "Find the common tag between these images:";
    if (this.gameMaster) {
      intro = `This tag was picked by <@${this.gameMaster.user.id}>!\n${intro}`;
    }
    this.play();
    return intro;
  }

  private async play(): Promise<void> {
    // A little "comfort pause".
    await sleep(1.5);

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

    // Wait for ties to reach here
    await sleep(tieSeconds);
    if (this.finished) return;
    this.finished = true;

    // Format a message about the outcome of the game.
    const realWinners = this.winners.filter((w) => w !== this.gameMaster);
    const [subjects, verb] =
      realWinners.length > 0
        ? [commatize(realWinners.map((m) => m.displayName)), "got it"]
        : this.winners.length > 0
        ? [commatize(this.winners.map((m) => m.displayName)), "gave it away"]
        : ["Nobody", "got it"];
    const message = `${subjects} ${verb}! The answer was ${mono(
      this.prettyTag
    )}.`;

    const wikiEmbed = await tagWikiEmbed(this.tag);
    await this.channel.send({
      content: message,
      embeds: wikiEmbed ? [wikiEmbed] : [],
    });
    const n = manualQueue.length;
    if (n > 0) {
      const thereAreTags =
        n === 1 ? "There is 1 manual tag" : `There are ${n} manual tags`;
      await this.channel.send(
        thereAreTags +
          " left in the queue! Use `/start` to play the next one, or `/manual` to queue up a tag.\n" +
          "The next tag in the queue was picked by **" +
          manualQueue[0].master.displayName +
          "**."
      );
    } else {
      await this.channel.send(
        "Type `/start` to play another game, or `/manual` to choose a tag for others to guess." +
          (isKancolle(this.tag)
            ? "\n(Tired of ship girls? Try `/start nokc` to play without Kantai Collection tags.)"
            : "")
      );
    }

    for (let i = 0; i < this.images.length; i++) {
      await this.imageMessages[i].edit({
        content: "_ _",
        embeds: [creditEmbed(this.images[i])],
      });
    }
  }

  isCorrect(guess: string): boolean {
    const guessAlnums = alnums(guess);
    return this.answers.some((a) => alnums(a) === guessAlnums);
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
const commands: ApplicationCommandData[] = [
  {
    name: "start",
    description: "Start a game with a random tag.",
    options: [
      {
        name: "nokc",
        description: "Exclude Kantai Collection tags.",
        type: 5, // boolean
        required: false,
      },
    ],
  },
  {
    name: "manual",
    description: "Hand-pick a tag for others to play with.",
    options: [
      {
        name: "tag",
        description: "The tag to play with",
        type: 3, // string
        required: true,
      },
    ],
  },
  {
    name: "scores",
    description: "Show the scoreboard.",
  },
  {
    name: "show",
    description: "Show a random image with the given tag(s).",
    options: [
      {
        name: "tag",
        description: "A tag to search for.",
        type: 3, // string
        required: true,
      },
      {
        name: "tag2",
        description: "A second tag to search for.",
        type: 3, // string
        required: false,
      },
      {
        name: "tag3",
        description: "A third tag to search for.",
        type: 3, // string
        required: false,
      },
      {
        name: "tag4",
        description: "A fourth tag to search for.",
        type: 3, // string
        required: false,
      },
    ],
  },
  {
    name: "wiki",
    description: "Look up the wiki entry for a tag.",
    options: [
      {
        name: "tag",
        description: "A tag to search for.",
        type: 3, // string
        required: true,
      },
    ],
  },
];

const koakumaToken = env("KOAKUMA_TOKEN");
const rest = new REST({ version: "9" }).setToken(koakumaToken);

console.log("Registering commands...");
rest.put(commandRoute, { body: commands });

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MEMBERS,
    Intents.FLAGS.GUILD_MESSAGES,
  ],
});

async function gameChannelSuggestion(guild: Guild): Promise<string> {
  const channels = await guild.channels.fetch(undefined, { cache: true });
  let mentions = [];
  for (const c of channels.values()) {
    if (c.isText() && gameChannelNames.includes(c.name))
      mentions.push(`<#${c.id}>`);
  }
  return "Let's play somewhere else: " + mentions.join(" ");
}

client.on("ready", () => {
  console.log(`Logged in as ${client?.user?.tag}! Loaded ${tags.length} tags.`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.channel?.type !== "GUILD_TEXT") return;
  if (!interaction.member) return;

  switch (interaction.commandName) {
    case "start": {
      if (!interaction.guild) return;
      if (!gameChannelNames.includes(interaction.channel.name)) {
        await interaction.reply(await gameChannelSuggestion(interaction.guild));
        return;
      }
      await interaction.deferReply();
      game = await Game.startRandom(interaction.channel);
      await interaction.editReply(game.start());
      break;
    }
    case "manual": {
      if (!interaction.guild) return;
      if (!gameChannelNames.includes(interaction.channel.name)) {
        await interaction.reply(await gameChannelSuggestion(interaction.guild));
        return;
      }
      if (game?.gameMaster?.id === interaction.user.id) {
        await interaction.reply({
          content: "Let's wait for your game to finish.",
          ephemeral: true,
        });
        return;
      } else if (
        manualQueue.some((m) => m.master.user.id === interaction.user.id)
      ) {
        await interaction.reply({
          content: "You're already in the queue.",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const tagOption = interaction.options.get("tag", true);
      let tag = String(tagOption.value).replace(/\s+/g, "_");
      let pre = "";
      const common = aliasOf.get(tag);
      if (common) {
        pre = `(That's just an alias of ${mono(
          normalize(common)
        )}, so I'm using that.)\n`;
        tag = common;
      }
      const images = await getImages(imagesPerGame, tag);
      if (!images) {
        interaction.editReply(
          pre + "Sorry, that tag doesn't have enough results."
        );
        return;
      }
      const master = interaction.member as GuildMember;
      const manual = { master, tag, images };
      const n = manualQueue.length;
      if (n > 0) {
        const areTags = n === 1 ? `is ${n} tag` : `are ${n} tags`;
        manualQueue.push(manual);
        await interaction.editReply(
          `${pre}I added your tag to the queue. There ${areTags} ahead of yours.`
        );
      } else if (game && !game.finished) {
        manualQueue.push(manual);
        await interaction.editReply(pre + "I'll use your tag after this game.");
      } else {
        await interaction.editReply(pre + "Starting a game with your tag!");
        game = Game.startManual(interaction.channel, manual);
        await interaction.channel.send(game.start());
      }
      break;
    }
    case "show": {
      await interaction.deferReply();
      let tags: string[] = [];
      for (const k of ["tag", "tag2", "tag3", "tag4"]) {
        const tag = interaction.options.get(k)?.value;
        if (tag) tags.push(String(tag).replace(/\s+/g, "_"));
      }
      const images = await getImages(1, tags.join(" "));
      if (images) {
        await interaction.editReply({
          content: `Here's what I found for ${mono(tags.join(" "))}:`,
          embeds: [creditEmbed(images[0])],
        });
      } else {
        await interaction.editReply("Sorry, no results.");
      }
      break;
    }
    case "wiki": {
      await interaction.deferReply();
      const tagOption = interaction.options.get("tag", true);
      const tag = String(tagOption.value).replace(/\s+/g, "_");
      const embed = await tagWikiEmbed(tag);
      if (embed) {
        await interaction.editReply({
          content: `Here's what I found:`,
          embeds: [embed],
        });
      } else {
        await interaction.editReply(`Sorry, no results for ${mono(tag)}.`);
      }
      break;
    }
    case "scores": {
      break;
    }
  }
});

async function processGuess(message: Message): Promise<void> {
  if (message.member && game && game.isCorrect(message.content)) {
    game.reveal(message.member);
  }
}

client.on("messageCreate", processGuess);
client.on("messageEdit", processGuess);

console.log("Logging in...");
client.login(koakumaToken);
