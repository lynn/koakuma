# Koakuma!
Discord bot for a Danbooru tag-guessing game. [**Play it here!**](https://discord.gg/ZyrkTTS)

![screenshot](screenshot.png)

## Gameplay
* Type `/start` to begin the game.

* First, Koakuma links a number of Danbooru images that share a common, randomly-selected tag.

* Then, she starts revealing the tag name letter-by-letter.

* Type tags in the channel to guess the answer!

## Is this SFW?
By default, Koakuma only serves images from `safebooru.donmai.us` — but that site’s standard for `safe` *probably* misaligns with that of your workplace. You can expect scantily-clad anime babes, but nothing downright explicit.

## Why Koakuma?
Well, she fetches stuff from libraries.

## Running Koakuma on your server
Set some environment variables:

```
KOAKUMA_TOKEN     # the Discord bot token
KOAKUMA_CLIENT_ID # the ID of the bot user to play as (right click, Copy ID)
KOAKUMA_GUILD     # the ID of the Discord server to play in (right click, Copy ID)

# optional, makes /scores work:
KOAKUMA_REDIS_URL=redis://localhost:6379

# optional, allows more tags in /show if you have a Danbooru Gold account:
KOAKUMA_DANBOORU_USER
KOAKUMA_DANBOORU_API_KEY  # get it from https://danbooru.donmai.us/profile
```

Then run `npm i` and `npx ts-node koakuma.ts` to start the bot.

I suggest you wrap it in a restart loop like so, in case the bot crashes somehow: `while true; do npx ts-node koakuma.ts; sleep 1; done`