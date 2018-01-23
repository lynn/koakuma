import asyncio, discord, json, lxml.html, os, random, re, redis, requests, time

REDIS_PORT = 6379
ROOT = 'https://safebooru.donmai.us'
NSFW_ROOT = 'https://danbooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0

ri = redis.StrictRedis.from_url(os.getenv('REDIS_URL'))

with open('tags.txt') as f: tags = f.read().strip().split('\n')
with open('aliases.json') as f: aliases = json.load(f)

def normalize(s):
    # normalize('alice_margatroid_(pc-98)') == normalize(' Alice  Margatroid\n') == 'alice margatroid'
    # normalize('shimakaze_(kantai_collection)_(cosplay)') == 'shimakaze'
    s = ' '.join(re.sub(r'[_-]', ' ', s.lower()).split())
    return re.sub(r'(\s*\([^)]+\))*$', '', s)

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
            has_latin = lambda s: s and re.match(r'[a-zA-Z]', s)
            if has_latin(p.text) or any(has_latin(c.tail) for c in p.iterchildren()):
                # Gotcha! Now strip parentheticals; they're mostly just Japanese names.
                stripped = re.sub(r'\s*\([^)]*\)', '', p.text_content())
                return discord.Embed(title=tag.replace('_', ' '), url=wiki_url, description=stripped)

    except requests.exceptions.RequestException as e:
        print(e)

class Game:
    def __init__(self, root, second_tag, manual_tag=None):
        print('Starting a new game...')
        while True:
            self.tag = manual_tag or random.choice(tags)
            self.pretty_tag = self.tag.replace('_', ' ')
            print('...trying tag "%s"' % self.tag)
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
                            self.urls = [root + re.sub(r'__\w+__', '', item['large_file_url']) for item in items]
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
client = discord.Client()

@client.event
async def on_ready():
    print('Ready; loaded %d tags.' % len(tags))

async def game_say(s):
    await client.send_message(game_channel, s)

@client.event
async def on_message(message):
    global game
    global game_master
    global game_channel
    say = lambda s: client.send_message(message.channel, s)
    if message.author == client.user: return
    if message.channel.name == 'feature-requests': return
    if message.server:
        table = message.channel.name.replace('games', 'leaderboard')

    manual_tag = None
    if not game and game_master and message.author.id == game_master.id and message.channel.is_private:
        manual_tag = re.sub('\s+', '_', message.content)

    reveal = None
    if message.content.startswith('!scores') and message.server:
        scores = ri.zrange(table, 0, -1, desc=True, withscores=True)
        entries = []
        for uid, score in scores:
            member = message.server.get_member(uid.decode('utf-8'))
            if member is None: continue
            entries.append('%s (%d win%s)' % (member.display_name, score, '' if score == 1 else 's'))
            if len(entries) >= 10: break
        await say('**Leaderboard**\n' + '\n'.join('%d. %s' % t for t in enumerate(entries, 1)))

    elif message.content.startswith('!manual'):
        if game: return
        game_channel = message.channel
        game_master = message.author
        await game_say("Waiting for %s to send me a tag..." % message.author.display_name)
        await client.send_message(game_master, 'Please give your tag.')

    elif message.content.startswith('!start') or manual_tag:
        if game: return
        if game_master and not manual_tag: return

        game_channel = game_channel or message.channel

        try:
            current = game = Game(NSFW_ROOT, '-rating:safe', manual_tag=manual_tag) if 'nsfw' in game_channel.name else Game(ROOT, '-ugoira', manual_tag=manual_tag)
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
        for i, masked in zip(indices, range(len(indices), 0, -1)):
            # Show letters faster if there are many masked ones left.
            if masked < 15 or masked % 2 == 0:
                await game_say('Hint: **`%s`**' % ''.join(mask))
                await asyncio.sleep(TIME_BETWEEN_LETTERS)
                if game is not current: return
            mask[i] = game.answer[i]

        reveal = "Time's up! The answer was **`%s`**." % game.pretty_tag

    elif game and message.channel.id == game_channel.id and normalize(message.content) in game.answers:
        answer = game.pretty_tag
        if game_master and game_master.id == message.author.id:
            reveal = '%s gave it away! The answer was **`%s`**!' % (message.author.display_name, answer)
        else:
            reveal = '%s got it! The answer was **`%s`**.' % (message.author.display_name, answer)
            # Only award points if the user didn't come up with the tag themselves...
            if message.server: ri.zincrby(table, message.author.id, 1)
        game_master = None

    if reveal:
        wiki_embed = tag_wiki_embed(game.tag)
        await client.send_message(game_channel, reveal, embed=wiki_embed)
        await game_say('Type `!start` to play another game, or `!manual` to choose a tag for others to guess.')
        game = None
        game_master = None
        game_channel = None

@client.event
async def on_message_edit(before, after):
    await on_message(after)

client.run(os.getenv('KOAKUMA_TOKEN'))
