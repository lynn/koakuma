import {
  Client,
  GuildMember,
  Intents,
  Message,
  PartialMessage,
  TextChannel,
} from "discord.js";
import { readFileSync } from "fs";
import { registerCommands } from "./commands";
import {
  gameChannelNames,
  imagesPerGame,
  secondsBetweenHints,
  secondsBetweenImages,
  tieSeconds,
} from "./constants";
import { awardPoint, scoreboard } from "./scores";
import { BooruImage, Manual } from "./types";
import {
  alnums,
  commatize,
  creditEmbed,
  env,
  gameChannelSuggestion,
  getImages,
  mono,
  normalize,
  shuffleArray,
  sleep,
  tagWikiEmbed,
} from "./util";

console.log("Loading tags and aliases...");
const aliases: Record<string, string[]> = require("./aliases.json");
let aliasOf: Map<string, string> = new Map();
for (const [k, vs] of Object.entries(aliases)) {
  for (const v of vs) aliasOf.set(v, k);
}

const tags = readFileSync("./tags.txt").toString().trimEnd().split("\n");
shuffleArray(tags);

let game: Game | undefined = undefined;
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

  static async random(
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

  static manual(channel: TextChannel, manual: Manual): Game {
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
      if (this.finished || this.winners.length) return;
    }

    // Slowly unmask the answer.
    const censored = this.answer.replace(/\w/g, "●");
    const lengths = censored.split(/\s+/).map((w) => w.split("●").length - 1);
    let mask = [...censored];
    let indices = mask.flatMap((x, i) => (x === "●" ? [i] : []));
    let lengthHint = ` (${lengths.join(", ")})`;
    shuffleArray(indices);
    for (let i = indices.length - 1; i >= 0; i--) {
      if (i < 15 || i % 2 === 0) {
        await this.channel.send("Hint: " + mono(mask.join("")) + lengthHint);
        lengthHint = "";
        await sleep(secondsBetweenHints);
        if (this.finished || this.winners.length) return;
      }
      mask[indices[i]] = this.answer[indices[i]];
    }

    this.reveal(undefined);
  }

  async reveal(member: GuildMember | undefined) {
    if (this.finished) return;
    let newScorePromise: Promise<number> | undefined = undefined;

    if (member !== undefined) {
      // Can't win a game twice:
      if (this.winners.includes(member)) return;
      this.winners.push(member);
      // Don't award points for giving manual tags away:
      if (member.user.id !== this.gameMaster?.user?.id) {
        newScorePromise = awardPoint(member.user.id);
      }
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
          " left in the queue! Type `/start` to play the next one, or `/manual` to queue up a tag.\n" +
          `The next tag in the queue was picked by **${manualQueue[0].master.displayName}**.`
      );
    } else {
      await this.channel.send(
        "Type `/start` to play another game, or `/manual` to choose a tag for others to guess."
      );
    }

    if (member !== undefined && newScorePromise !== undefined) {
      const newScore = await newScorePromise;
      if (newScore > 0 && newScore % 500 === 0) {
        const celebrationImage = await getImages(1, "dancing animated_gif");
        this.channel.send({
          content: `🎉 That was ${member.displayName}'s **${newScore}th** win! 🎉`,
          embeds: celebrationImage ? [creditEmbed(celebrationImage[0])] : [],
        });
      }
    }

    for (let i = 0; i < this.imageMessages.length; i++) {
      await this.imageMessages[i].edit({
        embeds: [creditEmbed(this.images[i])],
      });
    }
  }

  isCorrect(guess: string): boolean {
    const guessAlnums = alnums(guess);
    return this.answers.some((a) => alnums(a) === guessAlnums);
  }
}

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MEMBERS,
    Intents.FLAGS.GUILD_MESSAGES,
  ],
});

client.on("ready", () => {
  console.log(`Logged in as ${client?.user?.tag}! Loaded ${tags.length} tags.`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { channel, guild, options } = interaction;
  if (!channel) return;
  if (!channel.isText()) return;
  if (!interaction.member) return;

  switch (interaction.commandName) {
    case "start": {
      if (channel.type !== "GUILD_TEXT") return;
      if (!guild) return;
      if (!gameChannelNames.includes(channel.name)) {
        await interaction.reply(await gameChannelSuggestion(guild));
        return;
      }
      const nokc = options.getBoolean("nokc") === true;
      await interaction.deferReply();
      const manual = manualQueue.shift();
      const newGame = manual
        ? Game.manual(channel, manual)
        : await Game.random(channel, nokc);
      if (game && !game.finished) {
        await interaction.editReply("There's still an active game.");
        break;
      }
      game = newGame;
      await interaction.editReply(game.start());
      break;
    }
    case "manual": {
      if (channel.type !== "GUILD_TEXT") return;
      if (!guild) return;
      if (!gameChannelNames.includes(channel.name)) {
        await interaction.reply(await gameChannelSuggestion(guild));
        return;
      }
      if (
        game &&
        game.gameMaster?.id === interaction.user.id &&
        !game.finished
      ) {
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
      let tag = options.getString("tag", true).replace(/\s+/g, "_");
      let pre = "";
      const common = aliasOf.get(tag);
      if (common) {
        const it = mono(normalize(common));
        pre = `(That's just an alias of ${it}, so I'm using that.)\n`;
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
        game = Game.manual(channel, manual);
        await channel.send(game.start());
      }
      break;
    }
    case "show": {
      await interaction.deferReply();
      let tags: string[] = [];
      for (const k of ["tag", "tag2", "tag3", "tag4"]) {
        const tag = options.getString(k);
        if (tag) tags.push(tag.replace(/\s+/g, "_"));
      }
      const images = await getImages(1, tags.join(" "));
      const query = mono(tags.join(" "));
      if (images) {
        await interaction.editReply({
          content: `Here's what I found for ${query}:`,
          embeds: [creditEmbed(images[0])],
        });
      } else {
        await interaction.editReply(`Sorry, no results for ${query}.`);
      }
      break;
    }
    case "wiki": {
      await interaction.deferReply();
      const tag = options.getString("tag", true).replace(/\s+/g, "_");
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
      await interaction.deferReply();
      await interaction.editReply(await scoreboard(interaction));
      break;
    }
  }
});

async function processGuess(message: Message | PartialMessage): Promise<void> {
  const { member, content } = message;
  if (!content) return;
  if (/^!\w+/.test(content)) {
    const fixed = content.replace(/!/, "/").replace(/ .*/, "");
    message.reply(`I use slash-commands now. Try typing **${fixed}**!`);
  } else if (member && game && game.isCorrect(content)) {
    game.reveal(member);
  }
}

client.on("messageCreate", processGuess);
client.on("messageUpdate", (_, after) => processGuess(after));
client.on("error", console.error);
process.on("unhandledRejection", console.error);

registerCommands();
console.log("Logging in...");
client.login(env("KOAKUMA_TOKEN"));
