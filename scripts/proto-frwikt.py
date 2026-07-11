# Prototype : traduction FR d'un mot anglais via extraits fr.wiktionary (sans IA)
import requests, re, sys

H = {'user-agent': 'EcouteIntelligente/1.0'}
SKIP = {'Étymologie', 'Prononciation', 'Voir aussi', 'Références', 'Anagrammes',
        'Dérivés', 'Synonymes', 'Antonymes', 'Apparentés étymologiques',
        'Vocabulaire apparenté par le sens', 'Notes', 'Dérivés dans d’autres langues'}

def fr_trans(word):
    r = requests.get('https://fr.wiktionary.org/w/api.php', params={
        'action': 'query', 'format': 'json', 'prop': 'extracts', 'explaintext': 'true',
        'exsectionformat': 'wiki', 'titles': word, 'redirects': '1'}, timeout=15, headers=H)
    pages = r.json()['query']['pages']
    ext = next(iter(pages.values())).get('extract')
    if not ext:
        return None
    m = re.search(r'== Anglais ==\n(.*?)(?:\n== [^=]|\Z)', ext, re.S)
    if not m:
        return None
    sec = m.group(1)
    out = []
    for sub in re.finditer(r'\n=== ([^=]+) ===\n(.*?)(?=\n=== |\n==== |\Z)', sec, re.S):
        title, body = sub.group(1).strip(), sub.group(2)
        if title in SKIP:
            continue
        for l in (x.strip() for x in body.strip().splitlines()):
            if not l:
                continue
            if l.lower().startswith(word.lower()) or '\\' in l or l.startswith('('):
                continue
            if 'Exemple d' in l:
                continue
            out.append((title, l[:70]))
            break
    return out or None

for w in sys.argv[1:]:
    try:
        print(w, '->', fr_trans(w))
    except Exception as e:
        print(w, 'ERR', e)
