import { GuildMember, Interaction } from "discord.js";
import { createClient, RedisClient } from "redis";
import { topN } from "./constants";

const table = "koakuma_scores";

let client: RedisClient | undefined = undefined;
if (process.env.KOAKUMA_REDIS_URL) {
  client = createClient(process.env.KOAKUMA_REDIS_URL);
}

/// Award a point and return the new score.
export async function awardPoint(userId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    client === undefined
      ? resolve(0)
      : client.zincrby(table, 1, userId, (err, reply) => {
          err ? reject(err) : resolve(Number(reply));
        });
  });
}

export async function scoreboard(interaction: Interaction): Promise<string> {
  return new Promise((resolve) => {
    if (!client) {
      resolve("Scoring is disabled.");
      return;
    }
    client.zrevrange(table, 0, -1, "withscores", async (error, scores) => {
      let last_rank = -1;
      let last_score = -1;
      let mrank = -1;
      const ranked: Array<[number, GuildMember, number]> = [];
      for (let i = 0, j = 0; 2 * i < scores.length; i++) {
        let member;
        try {
          member = await interaction.guild!.members.fetch(scores[2 * i]);
          if (!member) continue;
        } catch (e) {
          continue;
        }
        const score = Number(scores[2 * i + 1]);
        ++j;
        const rank = score === last_score ? last_rank : j;
        if (interaction.user?.id === member.id) mrank = rank;
        ranked.push([rank, member, score]);
        last_rank = rank;
        last_score = score;
      }
      let entries: string[] = [];
      for (const [rank, member, score] of ranked) {
        if (rank <= topN || (mrank && Math.abs(rank - mrank) <= 1)) {
          if (mrank && mrank >= topN + 3 && rank === mrank - 1)
            entries.push("…");
          const wins = score === 1 ? "win" : "wins";
          let entry = `${rank}. ${member.displayName} (${score} ${wins})`;
          if (interaction.user?.id === member.id) entry = `**${entry}**`;
          entry += { 1: " 🥇", 2: " 🥈", 3: " 🥉" }[rank] ?? "";
          entries.push(entry);
        }
      }
      resolve("**Leaderboard**\n" + entries.join("\n"));
    });
  });
}
