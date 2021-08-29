import asyncio, discord, json, lxml.html, os, random, re, requests, time, urllib.parse
from typing import List, Dict
from datetime import datetime, timedelta
from dataclasses import dataclass
from fetch_tags import is_bad

ROOT = 'https://safebooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0
GAME_CHANNELS = ['games']
TOP_N = 10
TIE_SECONDS = 0.5

DANBOORU_USER = os.getenv('KOAKUMA_DANBOORU_USER')
DANBOORU_API_KEY = os.getenv('KOAKUMA_DANBOORU_API_KEY')

redis_url = os.getenv('KOAKUMA_REDIS_URL')
ri = None
if redis_url:
    import redis
    ri = redis.StrictRedis.from_url(redis_url)

with open('tags.txt') as f: tags = f.read().strip().split('\n')
with open('aliases.json') as f: aliases = json.load(f)

random.shuffle(tags)

def is_kancolle(tag):
    return 'kantai_collection' in tag or 'kancolle' in tag

def normalize(s):
    # normalize('alice_margatroid_(pc-98)') == normalize(' Alice  Margatroid\n') == 'alice margatroid'
    # normalize('shimakaze_(kantai_collection)_(cosplay)') == 'shimakaze'
    s = ' '.join(re.sub(r'_', ' ', s.lower()).split())
    return re.sub(r'[‘’]', "'", re.sub(r'[“”]', '"', re.sub(r'(\s*\([^)]+\))*$', '', s)))

def alnums(s):
    # Return only the alphanumeric characters of a string.
    # This is used to compare guesses and answers, so that "catgirl" == "cat-girl" == "cat girl" == "catgirl?".
    return ''.join(c for c in s if c.isalnum()) or s

def tag_wiki_embed(tag):
    """Return a Discord Embed describing the given tag, or None."""
    wiki_url = ROOT + '/wiki_pages/' + tag
    try:
        r = requests.get(wiki_url)
        r.raise_for_status()
        doc = lxml.html.fromstring(r.content.decode('utf-8'))

        # Find the first classless <p> tag that *directly* has Latin text in it.
        for p in doc.xpath('//*[@id="wiki-page-body"]/p[not(@class)]'):
            # text_content() changes 'a<br>b' into 'ab', so fix newlines:
            for br in p.xpath('//br'):
                br.tail = '\n' + (br.tail or '')
            has_latin = lambda s: s and re.search(r'[a-zA-Z]', s)
            if has_latin(p.text) or any(has_latin(c.tail) for c in p.iterchildren()):
                # Gotcha! Now strip parentheticals; they're mostly just Japanese names.
                stripped = re.sub(r'\s*\([^)]*\)', '', p.text_content())
                embed = discord.Embed(title=tag.replace('_', ' '), url=wiki_url, description=stripped)
                try: embed.set_footer(text=f"{requests.get(ROOT + '/counts/posts.json?tags=' + tag).json()['counts']['posts']:,} posts")
                except: pass
                return embed

    except requests.exceptions.RequestException as e:
        print(e)

def get_images(amount, tag):
    ids = set()
    images = []
    for retry in range(3):
        try:
            req = requests.get(ROOT + '/posts.json',
                    auth=(DANBOORU_USER, DANBOORU_API_KEY) if DANBOORU_API_KEY else None,
                    params={'limit': 50, 'random': 'true', 'tags': tag})
            js = req.json()
            for j in js:
                if 'large_file_url' not in j: continue
                if j['is_deleted']: continue
                if any(is_bad(tag) for tag in j['tag_string'].split()): continue
                if j['large_file_url'].endswith('.swf'): continue
                if j['id'] in ids: continue
                ids.add(j['id'])
                images.append(j)
                if len(images) >= amount:
                    return images
        except requests.exceptions.RequestException as e:
            print('Connection error. Retrying.', e)
        time.sleep(0.2)
    print('Ran out of tries, the given tag must not have many images...')
    return None

def credit(image):
    artist = (image['tag_string_artist'] or 'unknown').replace(' ', ', ').replace('_', ' ')
    pixiv = image['pixiv_id']
    source = f"https://www.pixiv.net/artworks/{pixiv}" if pixiv else image['source']
    source = "" if not source else f"<{source}>\n" if source.startswith("http") else f"Source: {source}\n"
    return f"<{ROOT}/posts/{image['id']}> by **{artist}**\n{source}{image['large_file_url']}"

class Game:
    tag_index = 0
    def __init__(self, channel, manual=None, no_kc=False):
        self.task = None
        self.tie_task = None
        self.winners = []
        self.winner_message = None
        self.winner_lock = asyncio.Lock()
        self.channel = channel
        self.images = []
        self.image_messages = []
        self.game_master = None

        if manual:
            self.game_master = manual.master
            self.tag = manual.tag
            self.images = manual.images
        else:
            while not self.images:
                self.tag = tags[Game.tag_index]
                Game.tag_index = (Game.tag_index + 1) % len(tags)
                if is_kancolle(self.tag) and no_kc: continue
                if Game.tag_index == 0: random.shuffle(tags)
                self.images = get_images(NUM_IMAGES, self.tag)
        self.start()

    def active(self):
        return self.task and not self.task.done() or self.tie_task and not self.tie_task.done()

    def start(self):
        assert self.tag and self.images
        self.pretty_tag = self.tag.replace('_', ' ')
        self.answer = normalize(self.tag)
        self.answers = [self.answer] + [normalize(tag) for tag in aliases.get(self.tag, [])]
        assert not self.task
        self.task = asyncio.create_task(self.play_game())

    async def play_game(self):
        if self.game_master:
            await self.channel.send(f"This tag was picked by {self.game_master.mention}!")
        await self.channel.send("Find the common tag between these images:")

        for image in self.images:
            # The URL looks like: /data/sample/__some_tags_here__sample-d5aefcdbc9db6f56ce504915f2128e2a.jpg
            # We strip the __\w+__ part as it might give away the answer.
            # url = urllib.parse.urljoin(ROOT, re.sub(r'__\w+__', '', image['large_file_url'])
            self.image_messages.append(await self.channel.send(image['large_file_url']))
            await asyncio.sleep(TIME_BETWEEN_IMAGES)

        # Slowly unmask the answer.
        mask = list(re.sub(r'\w', '●', self.answer))
        indices = [i for i, c in enumerate(mask) if c == '●']
        random.shuffle(indices)
        length_hint = ' (%s)' % ', '.join(str(w.count('●')) for w in ''.join(mask).split())
        for i, masked in zip(indices, range(len(indices), 0, -1)):
            # Show letters faster if there are many masked ones left.
            if masked < 15 or masked % 2 == 0:
                await self.channel.send('Hint: **`%s`**' % ''.join(mask) + length_hint)
                length_hint = ''
                await asyncio.sleep(TIME_BETWEEN_LETTERS)
            mask[i] = self.answer[i]

        await self.show_winner(None)

    async def show_winner(self, member):
        async with self.winner_lock:
            if member:  # (None here means nobody got it in time.)
                # Can't win a game twice:
                if member in self.winners: return
                self.winners.append(member)

                # Award points for public games, but not for giving away the answer.
                if ri and self.channel.guild and member != game.game_master:
                    # TODO: leaderboards per guild
                    ri.zincrby('leaderboard', 1, member.id)

            # Format a message about the outcome of the game.
            outcome = "Nobody got it"
            if self.winners:
                real_winners = [w for w in self.winners if w != self.game_master]
                subjects, verb = (real_winners, "got it") if real_winners else (self.winners, "gave it away") if self.winners else ("Nobody", "got it")
                names = re.sub(r"(.*), ", r"\1 and ", ", ".join(m.display_name for m in subjects))
                outcome = f"{names} {verb}"
            message = f"{outcome}! The answer was **`{self.pretty_tag}`**."

            if self.winner_message:
                await self.winner_message.edit(content=message)
            else:
                wiki_embed = tag_wiki_embed(game.tag)
                self.winner_message = await self.channel.send(message, embed=wiki_embed)
                if (n := len(manual_queue)) > 0:
                    there_are_tags = "There is 1 manual tag" if n == 1 else f"There are {n} manual tags"
                    await self.channel.send(f"{there_are_tags} left in the queue! Type `!start` to play the next one, or `!manual` to queue up a tag.\n"
                            f"The next tag in the queue was picked by **{manual_queue[0].master.display_name}**.")
                else:
                    await self.channel.send('Type `!start` to play another game, or `!manual` to choose a tag for others to guess.' +
                        ('\n(Tired of ship girls? Try `!start nokc` to play without Kantai Collection tags.)' if is_kancolle(self.tag) else ''))
                for image, msg in zip(self.images, self.image_messages):
                    await msg.edit(content=credit(image))

    async def reveal(self, member):
        if not self.task.done():
            self.task.cancel()
            self.tie_task = asyncio.create_task(asyncio.sleep(TIE_SECONDS))
        if self.active():
            await self.show_winner(member)

game = None

@dataclass
class Manual:
    master: discord.Member
    tag: str
    images: List[Dict]

manual_queue: List[Manual] = []

@dataclass
class RanManual:
    time: datetime
    channel: discord.TextChannel

ran_manual: Dict[discord.Member, RanManual] = {}

def recently_ran_manual(author):
    rm = ran_manual.get(author)
    if rm and rm.time > datetime.now() - timedelta(minutes=10):
        return rm.channel
    else:
        return None

intents = discord.Intents.default()
intents.members = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f"Ready; loaded {len(tags)} tags.")

@client.event
async def on_message(message):
    global game
    if message.author == client.user: return

    if isinstance(message.channel, discord.abc.PrivateChannel):
        if not (channel := recently_ran_manual(message.author)):
            await message.channel.send("To start a manual game, first type `!manual` in the games channel.")
            return
        tag = re.sub(r'\s+', '_', message.content.strip())
        for k, v in aliases.items():
            if tag in v:
                await message.channel.send(f"That's just an alias of `{k}`, so I'm starting a game with that.")
                tag = k
                break
        images = get_images(NUM_IMAGES, tag)
        if not images:
            return await message.channel.send("Not enough results, try another tag.")
        del ran_manual[message.author]
        master = channel.guild.get_member(message.author.id)
        manual_queue.append(Manual(master, tag, images))
        n = len(manual_queue)
        added_to_queue = f"**{master.display_name}** added a manual tag to the queue. (Now {n} tag{'s'*(n!=1)})"
        if game and game.active():
            if n == 1:
                await message.channel.send("I'll use your tag after this game finishes.")
            else:
                are_tags = "is {n-1} tag" if n-1 == 1 else "are {n-1} tags"
                await message.channel.send(f"I added your tag to the queue. There {are_tags} ahead of yours.")
            await channel.send(added_to_queue)
        elif n == 1:
            await message.channel.send("Okay, starting a game with your tag!")
            game = Game(channel, manual=manual_queue.pop(0))
        else:
            await message.channel.send("I added your tag to the queue.")
            await channel.send(added_to_queue)

    elif ri and message.content.startswith('!scores') and message.guild:
        scores = ri.zrange('leaderboard', 0, -1, desc=True, withscores=True)

        last_i = last_score = None
        mrank = None
        ranked = []
        for i, (uid, score) in enumerate(scores, 1):
            member = message.guild.get_member(int(uid.decode('utf-8')))
            if member is None: continue
            rank = last_i if score == last_score else i
            if message.author == member: mrank = rank
            ranked.append((rank, member, score))
            last_i = i
            last_score = score

        entries = []
        for rank, member, score in ranked:
            if rank <= TOP_N or mrank and abs(rank - mrank) <= 1:
                if mrank and mrank >= TOP_N + 3 and rank == mrank - 1:
                    entries.append('…')
                wins = 'win' if score == 1 else 'wins'
                entry = f'{rank}. {member.display_name} ({int(score)} {wins})'
                if message.author == member: entry = f'**{entry}**'
                entry += {1: ' 🥇', 2: ' 🥈', 3: ' 🥉'}.get(rank, '')
                entries.append(entry)

        await message.channel.send('**Leaderboard**\n' + '\n'.join(entries))

    elif message.content.startswith('!show'):
        if game and game.active(): return
        query = '_'.join(message.content.split()[1:])
        images = get_images(1, re.sub(r'_(AND|&&)_', ' ', query))
        await message.channel.send(credit(images[0]) if images else "No results.")

    elif message.content.startswith('!wiki'):
        if game and game.active(): return
        query = '_'.join(message.content.split()[1:])
        embed = tag_wiki_embed(query)
        await message.channel.send("Here's what I found!" if embed else "No results.", embed=embed)

    elif message.content.startswith('!manual'):
        if any(m.master == message.author for m in manual_queue):
            return await message.author.send("You're already in the queue.")
        elif game and game.active() and game.game_master == message.author:
            return await message.author.send("Your game is still ongoing.")

        ran_manual[message.author] = RanManual(datetime.now(), message.channel)
        await message.author.send('Please give your tag.')

    elif message.content.startswith('!start'):
        if isinstance(message.channel, discord.abc.GuildChannel) and message.channel.name not in GAME_CHANNELS:
            return await message.channel.send("Let's play somewhere else: " + " ".join(c.mention for c in message.guild.channels if c.name in GAME_CHANNELS))
        if game and game.active(): return

        if manual_queue:
            game = Game(message.channel, manual=manual_queue.pop(0))
        else:
            game = Game(message.channel, no_kc='nokc' in message.content)

    elif game and game.active() and message.channel == game.channel and alnums(normalize(message.content)) in map(alnums, game.answers):
        await game.reveal(message.author)

@client.event
async def on_message_edit(before, after):
    await on_message(after)

if __name__ == '__main__':
    client.run(os.getenv('KOAKUMA_TOKEN'))
