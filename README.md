# Koakuma!
Discord bot for a Danbooru tag-guessing game. [**Play it here!**](https://discord.gg/ZyrkTTS)

![screenshot](screenshot.png)

## Gameplay
* Type `!start` to begin the game.

* First, Koakuma links a number of Danbooru images that share a common, randomly-selected tag.

* Then, she starts revealing the tag name letter-by-letter.

* Type tags in the channel to guess the answer!

## Is this SFW?
By default, Koakuma only serves images from `safebooru.donmai.us` — but that site’s standard for `safe` *probably* misaligns with that of your workplace. You can expect scantily-clad anime babes, but nothing downright explicit.

## Why Koakuma?
Well, she fetches stuff from libraries.

## Running Koakuma on your server
Store a bot client token in the environment variable `KOAKUMA_TOKEN`, then `python3 koakuma.py` to run the bot.

For leaderboard support (`!scores`), either supply a `REDIS_URL`, or um, snip out all references to that stuff from the code.
