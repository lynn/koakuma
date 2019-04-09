from collections import defaultdict
import codecs, requests
import sys
import json

TAGS_PAGE_URL = 'https://danbooru.donmai.us/tags.json?limit=1000&search[order]=count&page={}'
TAG_ALIASES_PAGE_URL = 'https://danbooru.donmai.us/tag_aliases.json?limit=1000&page={}'

PAGES = 7  # 7000 tags

GENERAL = 0
ARTIST = 1
COPYRIGHT = 3
CHARACTER = 4
META = 5

def alphanumeric_count(string):
    return sum(1 for c in string if c.isalnum())

bad_tags = [codecs.decode(tag, 'rot_13') for tag in [
    'anmv',
    'encr',
    'gehgu',
    'htbven',
    'lbh_tbaan_trg_encrq',
    'qbhwvafuv',
    'qenjsnt',
    'shgnanev',
    'vzzvarag_encr',
    'ybyv',
]]

def fetch_aliases():
    tag_aliases = defaultdict(list)

    for i in range(1, 21):
        print('Fetching page {} of aliases...'.format(i), file=sys.stderr)
        url = TAG_ALIASES_PAGE_URL.format(i)
        page = requests.get(url).json()
        if not page: break
        for alias_data in page:
            antecedent = alias_data['antecedent_name']
            consequent = alias_data['consequent_name']
            status = alias_data['status']
            if status != 'active': continue
            tag_aliases[consequent].append(antecedent)

    print('Writing aliases.json.', file=sys.stderr)
    with open('aliases.json', 'w') as f:
        json.dump(tag_aliases, f)

def fetch_tags():
    tags = []

    for i in range(1, PAGES + 1):
        print('Fetching page {} of tags...'.format(i), file=sys.stderr)
        url = TAGS_PAGE_URL.format(i)
        for tag_data in requests.get(url).json():
            tag_name = tag_data['name']
            tag_category = tag_data['category']

            if i <= 4:
                allowed = [GENERAL, COPYRIGHT, CHARACTER]
            else:
                allowed = [GENERAL]

            wordish = alphanumeric_count(tag_name) >= 3
            decent = tag_name not in bad_tags
            relevant = tag_category in allowed

            if wordish and decent and relevant:
                # if i == 7 and tag_category == GENERAL: print(tag_name)
                tags.append(tag_name)

    print('Writing tags.txt.', file=sys.stderr)
    with open('tags.txt', 'w') as f:
        f.write('\n'.join(sorted(tags)) + '\n')

fetch_tags()
fetch_aliases()
