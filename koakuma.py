import asyncio, discord, json, random, os, pprint, re, requests, time

DANBOORU = 'https://danbooru.donmai.us'
NUM_IMAGES = 9
TIME_BETWEEN_IMAGES = 3.0
TIME_BETWEEN_LETTERS = 30.0

def normalize(s):
    s = ' '.join(s.lower().replace('_', ' ').split())
    # Remove paren credits, e.g. "serval (kemono friends)" → "serval"
    return re.sub(r'\s*\([^)]+\)$', '', s)

class Game:
    with open('tags.txt') as f: tags = f.read().strip().split('\n')
    with open('aliases.json') as f: aliases = json.load(f)

    def __init__(self, safe=True):
        print('Starting a new game...')
        while True:
            self.tag = random.choice(self.tags)
            self.pretty_tag = self.tag.replace('_', ' ')
            self.answer = normalize(self.tag)
            self.answers = [self.answer] + [normalize(x) for x in self.aliases.get(self.answer, [])]
            url = DANBOORU + '/posts.json?limit=%d&random=true&tags=%s' % (NUM_IMAGES, self.tag)
            if safe: url += ' rating:s'
            js = None
            try:
                js = requests.get(url).json()
                self.urls = [DANBOORU + '/data/' + j['file_url'].split('__')[-1] for j in js]
            except:
                time.sleep(1)
                continue
            if len(self.urls) == NUM_IMAGES:
                break

game = None
client = discord.Client()

@client.event
async def on_message(message):
    global game
    say = lambda s: client.send_message(message.channel, s)
    if message.author == client.user: return

    if message.content.startswith('!start'):
        if game:
            await say('Already started.')
        else:
            current = game = Game()
            await say("Find the common tag between these %d images:" % NUM_IMAGES)
            for url in game.urls:
                await say(url)
                await asyncio.sleep(TIME_BETWEEN_IMAGES)
                if game is not current: return

            mask = list(re.sub(r"[^-() _]", '●', game.answer))
            indices = [i for i, c in enumerate(mask) if c == '●']
            random.shuffle(indices)
            for i in indices:
                await say('Hint: **`%s`**' % ''.join(mask))
                await asyncio.sleep(TIME_BETWEEN_LETTERS)
                if game is not current: return
                mask[i] = game.answer[i]

            await say("Time's up! The answer was **`%s`**." % game.pretty_tag)
            current = game = None

    elif message.content.startswith('!stop'):
        if game:
            answer = game.pretty_tag; game = None
            await say('Aborting game. The answer was **`%s`**.' % answer)
        else:
            await say('No game active.')

    elif game and normalize(message.content) in game.answers:
        answer = game.pretty_tag; game = None
        await say('%s got it! The answer was **`%s`**.' % (message.author.display_name, answer))
        await say('Type `!start` to play another game.')

client.run(os.getenv('KOAKUMA_TOKEN'))
