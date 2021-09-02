import { GuildMember } from "discord.js";

export interface BooruImage {
  tag_string: string;
  tag_string_artist: string;
  tag_string_character: string;
  tag_string_copyright: string;
  pixiv_id?: string;
  id: string;
  source?: string;
  large_file_url: string;
  is_banned: boolean;
  is_deleted: boolean;
}

export interface Manual {
  master: GuildMember;
  tag: string;
  images: BooruImage[];
}
