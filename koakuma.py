import asyncio, discord, json, lxml.html, os, random, re, requests, time, urllib.parse
from fetch_tags import is_bad

ROOT = 'https://safebooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0
GAME_CHANNELS = ['games']
TOP_N = 10

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
    # Also turn fancy quotes into ASCII ones.
    s = ' '.join(re.sub(r'[_]', ' ', s.lower()).split())
    return re.sub(r'[‘’]', "'", re.sub(r'[“”]', '"', re.sub(r'(\s*\([^)]+\))*$', '', s)))

def alnums(s):
    # Return only the alphanumeric characters of a string.
    # This is used to compare guesses and answers, so that "catgirl" == "cat-girl" == "cat girl" == "catgirl?".
    return ''.join(c for c in s if c.isalnum())

def no_results(query):
    q = query.replace("_", " ")
    return random.choice([
        f"I couldn't find anything for `{q}`...",
        f"No results for `{q}`.",
        f"I don't even know what `{q}` is.",
        f"`{q}`? Let's see... nope, nothing.",
        f"💤",
        f"💤💬 _mumble mumble... `{normalize(random.choice(tags))}`..._",
    ])

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
                return discord.Embed(title=tag.replace('_', ' '), url=wiki_url, description=stripped)

    except requests.exceptions.RequestException as e:
        print(e)

def get_image_urls(amount, tag):
    retries = 2
    items = []
    while retries and len(items) < amount:
        retries -= 1
        try:
            js = requests.get(ROOT + '/posts.json', params={'limit': 50, 'random': 'true', 'tags': tag}).json()
            for j in js:
                if any(is_bad(tag) for tag in j['tag_string'].split()):
                    continue
                if 'large_file_url' in j and j['id'] not in [item['id'] for item in items]:
                    items.append(j)
                if len(items) >= amount:
                    # The URL looks like: /data/sample/__some_tags_here__sample-d5aefcdbc9db6f56ce504915f2128e2a.jpg
                    # We strip the __\w+__ part as it might give away the answer.
                    return [urllib.parse.urljoin(ROOT, re.sub(r'__\w+__', '', item['large_file_url'])) for item in items]
        except:
            print('Connection error. Retrying.')
        time.sleep(0.2)
    print('Ran out of tries, the given tag must not have many images...')
    return None

class Game:
    tag_index = 0
    def __init__(self, manual_tag=None, no_kc=False):
        print('Starting a new game...')
        while True:
            if manual_tag:
                self.tag = manual_tag
            else:
                self.tag = tags[Game.tag_index]
                Game.tag_index = (Game.tag_index + 1) % len(tags)
                if is_kancolle(self.tag) and no_kc: continue
                if Game.tag_index == 0: random.shuffle(tags)

            self.pretty_tag = self.tag.replace('_', ' ')
            self.answer = normalize(self.tag)
            self.answers = [self.answer] + [normalize(tag) for tag in aliases.get(self.tag, [])]
            self.urls = get_image_urls(NUM_IMAGES, self.tag)
            if self.urls:
                return
            elif manual_tag:
                raise ValueError("Manual tag didn't give enough results!")

game = None
game_master = None
game_channel = None
intents = discord.Intents.default()
intents.members = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print('Ready; loaded %d tags.' % len(tags))

async def game_say(s):
    await game_channel.send(s)

@client.event
async def on_message(message):
    global game
    global game_master
    global game_channel
    say = lambda s: message.channel.send(s)
    if message.author == client.user: return
    if message.guild: table = 'leaderboard'

    manual_tag = None
    if not game and game_master and message.author.id == game_master.id and isinstance(message.channel, discord.abc.PrivateChannel):
        manual_tag = re.sub('\s+', '_', message.content)
        for k, v in aliases.items():
            if manual_tag in v:
                await game_master.send(f"That's just an alias of `{k}`, so I'm starting a game with that.")
                manual_tag = k
                break

    reveal = None
    if ri and message.content.startswith('!scores') and message.guild:
        scores = ri.zrange(table, 0, -1, desc=True, withscores=True)

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

        await say('**Leaderboard**\n' + '\n'.join(entries))

    elif message.content.startswith('!show') and not game:
        query = '_'.join(message.content.split()[1:])
        urls = get_image_urls(1, re.sub(r'_(AND|&&)_', ' ', query))
        await say(urls[0] if urls else no_results(query))

    elif message.content.startswith('!wiki') and not game:
        query = '_'.join(message.content.split()[1:])
        embed = tag_wiki_embed(query)
        await message.channel.send("Here's what I found!" if embed else no_results(query), embed=embed)

    elif message.content.startswith('!manual'):
        if isinstance(message.channel, discord.abc.GuildChannel) and message.channel.name not in GAME_CHANNELS:
            await say("Let's play somewhere else: " + " ".join(c.mention for c in message.guild.channels if c.name in GAME_CHANNELS))
            return
        if game: return
        game_channel = message.channel
        game_master = message.author
        await game_say("Waiting for %s to send me a tag..." % message.author.display_name)
        await game_master.send('Please give your tag.')

    elif message.content.startswith('!start') or manual_tag:
        if isinstance(message.channel, discord.abc.GuildChannel) and message.channel.name not in GAME_CHANNELS:
            await say("Let's play somewhere else: " + " ".join(c.mention for c in message.guild.channels if c.name in GAME_CHANNELS))
            return
        if game: return
        if game_master and not manual_tag: return

        game_channel = game_channel or message.channel

        try:
            no_kc = 'nokc' in message.content
            current = game = Game(manual_tag=manual_tag, no_kc=no_kc)
            if manual_tag: await say("Started a game with tag \"{}\"".format(manual_tag))
        except ValueError:
            await say("That tag doesn't give enough results, please try a different one!")
            return

        if manual_tag:
            await game_say('A tag has been decided by %s!' % game_master.display_name)
        await game_say("Find the common tag between these images:")

        for url in game.urls:
            await game_say(url)
            await asyncio.sleep(TIME_BETWEEN_IMAGES)
            if game is not current: return

        # Slowly unmask the answer.
        mask = list(re.sub(r'\w', '●', game.answer))
        indices = [i for i, c in enumerate(mask) if c == '●']
        random.shuffle(indices)
        length_hint = ' (%s)' % ', '.join(str(w.count('●')) for w in ''.join(mask).split())
        for i, masked in zip(indices, range(len(indices), 0, -1)):
            # Show letters faster if there are many masked ones left.
            if masked < 15 or masked % 2 == 0:
                await game_say('Hint: **`%s`**' % ''.join(mask) + length_hint)
                length_hint = ''
                await asyncio.sleep(TIME_BETWEEN_LETTERS)
                if game is not current: return
            mask[i] = game.answer[i]

        reveal = "Time's up! The answer was **`%s`**." % game.pretty_tag

    elif game and message.channel.id == game_channel.id and alnums(normalize(message.content)) in map(alnums, game.answers):
        answer = game.pretty_tag
        if game_master and game_master.id == message.author.id:
            reveal = '%s gave it away! The answer was **`%s`**!' % (message.author.display_name, answer)
        else:
            reveal = '%s got it! The answer was **`%s`**.' % (message.author.display_name, answer)
            if ri and message.guild:
                ri.zincrby(table, 1, message.author.id)
        game_master = None

    if reveal:
        wiki_embed = tag_wiki_embed(game.tag)
        await game_channel.send(reveal, embed=wiki_embed)
        await game_say('Type `!start` to play another game, or `!manual` to choose a tag for others to guess.')
        if is_kancolle(game.tag):
            await game_say('(Tired of ship girls? Try `!start nokc` to play without Kantai Collection tags.)')
        game = None
        game_master = None
        game_channel = None

@client.event
async def on_message_edit(before, after):
    await on_message(after)

if __name__ == '__main__':
    client.run(os.getenv('KOAKUMA_TOKEN'))
