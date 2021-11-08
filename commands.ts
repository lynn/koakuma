import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/rest/v9";
import { ApplicationCommandData } from "discord.js";
import { env } from "./util";

const stringType = 3;
const booleanType = 5;

const clientId = env("KOAKUMA_CLIENT_ID");
const guildId = env("KOAKUMA_GUILD");
const commandRoute = Routes.applicationGuildCommands(clientId, guildId);
const commands: ApplicationCommandData[] = [
  {
    name: "start",
    description: "Start a game with a random tag.",
    options: [],
  },
  {
    name: "manual",
    description: "Hand-pick a tag for others to play with.",
    options: [
      {
        name: "tag",
        description: "The tag to play with",
        type: stringType,
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
        type: stringType,
        required: true,
      },
      {
        name: "tag2",
        description: "A second tag to search for.",
        type: stringType,
        required: false,
      },
      {
        name: "tag3",
        description: "A third tag to search for.",
        type: stringType,
        required: false,
      },
      {
        name: "tag4",
        description: "A fourth tag to search for.",
        type: stringType,
        required: false,
      },
      {
        name: "tag5",
        description: "A fifth tag to search for.",
        type: stringType,
        required: false,
      },
      {
        name: "tag6",
        description: "A sixth tag to search for.",
        type: stringType,
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
        type: stringType,
        required: true,
      },
    ],
  },
];

export function registerCommands(): void {
  console.log("Registering commands...");
  const koakumaToken = env("KOAKUMA_TOKEN");
  const rest = new REST({ version: "9" }).setToken(koakumaToken);
  rest.put(commandRoute, { body: commands });
}
