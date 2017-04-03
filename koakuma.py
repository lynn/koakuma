import asyncio, discord, json, random, os, re, requests, time

ROOT = 'https://danbooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0

with open('tags.txt') as f: tags = f.read().strip().split('\n')
with open('aliases.json') as f: aliases = json.load(f)

def normalize(s):
    s = ' '.join(s.lower().replace('_', ' ').split())
    # Remove paren credits, e.g. "serval (kemono friends)" → "serval"
    return re.sub(r'\s*\([^)]+\)$', '', s)

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

        await say("Time's up! The answer was **`%s`**." % game.pretty_tag)
        game = None

    elif game and normalize(message.content) in game.answers:
        answer = game.pretty_tag
        game = None
        await say('%s got it! The answer was **`%s`**.' % (message.author.display_name, answer))
        await say('Type `!start` to play another game.')

@client.event
async def on_message_edit(before, after):
    await on_message(after)

client.run(os.getenv('KOAKUMA_TOKEN'))
