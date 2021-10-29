from collections import defaultdict
import codecs, requests
import sys
import re
import json

TAGS_PAGE_URL = 'https://danbooru.donmai.us/tags.json?limit=1000&search[order]=count&page={}'
TAG_ALIASES_PAGE_URL = 'https://danbooru.donmai.us/tag_aliases.json?limit=1000&page={}'

PAGES = 13  # 13000 tags

GENERAL = 0
ARTIST = 1
COPYRIGHT = 3
CHARACTER = 4
META = 5

def alphanumeric_count(string):
    return sum(1 for c in string if c.isalnum())

def is_bad(tag):
    return re.search(codecs.decode(
        r"(_|^)(anmv|encrq?|gehgu|fcbvyref|htbven|qenjsnt|shgn(anev)?|\j+wbo|pbaqbzf?|oehvfr|theb"
        r"|ybyv|nohfr|elban|cravf(rf)?|intvany?|nany|frk|(cer)?phz(fubg)?|crargengvba|chffl|betnfz|crr"
        r"|abbfr|rerpgvba|pebgpu(yrff)?|qrngu|chovp|^choyvp(_hfr|_ahqvgl)?$|sryyngvb|phaavyvathf"
        r"|znfgheongvba|svatrevat)(_|$)", "rot_13"), tag)

def is_unguessable(tag):
    return tag in ["one-hour_drawing_challenge", "doujinshi", "original"]

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
            decent = not (is_bad(tag_name) or is_unguessable(tag_name))
            relevant = tag_category in allowed

            if wordish and decent and relevant:
                if i > 9 and tag_category == GENERAL: print(tag_name)
                tags.append(tag_name)

    print('Writing tags.txt.', file=sys.stderr)
    with open('tags.txt', 'w') as f:
        f.write('\n'.join(sorted(tags)) + '\n')

if __name__ == '__main__':
    fetch_tags()
    #fetch_aliases()
