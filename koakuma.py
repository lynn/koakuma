import asyncio, discord, json, lxml.html, os, random, re, requests, time, urllib.parse

ROOT = 'https://safebooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0
GAME_CHANNELS = ['games']

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

class Game:
    tag_index = 0
    def __init__(self, root, second_tag, manual_tag=None, no_kc=False):
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
            url = root + '/posts.json?limit=%d&random=true&tags=%s %s' % (NUM_IMAGES, self.tag, second_tag)
            # Try a couple of times to gather (NUM_IMAGES) unique images
            retries = 10
            items = []
            while retries and len(items) < NUM_IMAGES:
                retries -= 1
                try:
                    js = requests.get(url).json()
                    for j in js:
                        if 'large_file_url' in j and j['id'] not in [item['id'] for item in items]:
                            items.append(j)
                        if len(items) == NUM_IMAGES:
                            # The URL looks like: /data/sample/__some_tags_here__sample-d5aefcdbc9db6f56ce504915f2128e2a.jpg
                            # We strip the __\w+__ part as it might give away the answer.
                            self.urls = [urllib.parse.urljoin(root, re.sub(r'__\w+__', '', item['large_file_url'])) for item in items]
                            return
                except:
                    print('Connection error. Retrying.')
                time.sleep(0.2)
            print('Ran out of tries, the given tag must not have many images...')
            if manual_tag:
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
    if isinstance(message.channel, discord.abc.GuildChannel) and message.channel.name not in GAME_CHANNELS: return
    if message.guild: table = 'leaderboard'

    manual_tag = None
    if not game and game_master and message.author.id == game_master.id and isinstance(message.channel, discord.abc.PrivateChannel):
        manual_tag = re.sub('\s+', '_', message.content)

    reveal = None
    if ri and message.content.startswith('!scores') and message.guild:
        scores = ri.zrange(table, 0, -1, desc=True, withscores=True)
        entries = []
        last_t = last_score = None
        for t, (uid, score) in enumerate(scores, 1):
            member = message.guild.get_member(int(uid.decode('utf-8')))
            if member is None: continue
            rank = last_t if score == last_score else t
            if rank <= 10 or message.author == member:
                wins = 'win' if score == 1 else 'wins'
                entry = f'{rank}. {member.display_name} ({int(score)} {wins})'
                if message.author == member: entry = f'**{entry}**'
                entry += {1: ' 🥇', 2: ' 🥈', 3: ' 🥉'}.get(rank, '')
                entries.append(entry)
            last_t = t
            last_score = score

        await say('**Leaderboard**\n' + '\n'.join(entries))

    elif message.content.startswith('!manual'):
        if game: return
        game_channel = message.channel
        game_master = message.author
        await game_say("Waiting for %s to send me a tag..." % message.author.display_name)
        await game_master.send('Please give your tag.')

    elif message.content.startswith('!start') or manual_tag:
        if game: return
        if game_master and not manual_tag: return

        game_channel = game_channel or message.channel

        try:
            no_kc = 'nokc' in message.content
            current = game = Game(ROOT, '-ugoira', manual_tag=manual_tag, no_kc=no_kc)
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
