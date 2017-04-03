import asyncio, discord, json, lxml.html, random, os, re, requests, time

ROOT = 'https://danbooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0

with open('tags.txt') as f: tags = f.read().strip().split('\n')
with open('aliases.json') as f: aliases = json.load(f)

def normalize(s):
    # normalize('alice_margatroid_(pc-98)') == normalize(' Alice  Margatroid\n') == 'alice margatroid'
    s = ' '.join(s.lower().replace('_', ' ').split())
    return re.sub(r'\s*\([^)]+\)$', '', s)

def tag_wiki_embed(tag):
    """Return a Discord Embed describing the given tag, or None."""
    wiki_url = 'https://danbooru.donmai.us/wiki_pages/' + tag
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
    def __init__(self):
        print('Starting a new game...')
        while True:
            self.tag = random.choice(tags)
            self.pretty_tag = self.tag.replace('_', ' ')
            self.answer = normalize(self.tag)
            self.answers = [self.answer] + [normalize(tag) for tag in aliases.get(self.answer, [])]
            url = ROOT + '/posts.json?limit=%d&random=true&tags=%s rating:s' % (NUM_IMAGES, self.tag)
            try:
                js = requests.get(url).json()
                self.urls = [ROOT + re.sub(r'__\w+__', '', j['large_file_url']) for j in js]
            except:
                time.sleep(1)
                continue
            if len(self.urls) == NUM_IMAGES:
                break

game = None
client = discord.Client()

@client.event
async def on_ready():
    print('Ready; loaded %d tags.' % len(tags))

@client.event
async def on_message(message):
    global game
    say = lambda s: client.send_message(message.channel, s)
    if message.author == client.user: return

    reveal = None
    if message.content.startswith('!start'):
        if game: return
        current = game = Game()
        await say("Find the common tag between these images:")
        for url in game.urls:
            await say(url)
            await asyncio.sleep(TIME_BETWEEN_IMAGES)
            if game is not current: return

        # Slowly unmask the answer.
        mask = list(re.sub(r'\w', '●', game.answer))
        indices = [i for i, c in enumerate(mask) if c == '●']
        random.shuffle(indices)
        for i in indices:
            await say('Hint: **`%s`**' % ''.join(mask))
            await asyncio.sleep(TIME_BETWEEN_LETTERS)
            if game is not current: return
            mask[i] = game.answer[i]

        reveal = "Time's up! The answer was **`%s`**." % game.pretty_tag

    elif game and normalize(message.content) in game.answers:
        answer = game.pretty_tag
        reveal = '%s got it! The answer was **`%s`**.' % (message.author.display_name, answer)

    if reveal:
        wiki_embed = tag_wiki_embed(game.tag)
        game = None
        await client.send_message(message.channel, reveal, embed=wiki_embed)
        await say('Type `!start` to play another game.')

@client.event
async def on_message_edit(before, after):
    await on_message(after)

client.run(os.getenv('KOAKUMA_TOKEN'))
