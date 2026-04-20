"""Generate noise variants from existing samples for v2-draft-r3.

Noise modes (from SCHEMA.md):
- typo          — character-level perturbations
- emoji         — insert 1-3 emojis
- code          — splice code snippets into text
- short         — truncate to ≤3 words
- long          — pad with rambling filler
- mixed-lang    — inject English words into Chinese text or vice versa

Each variant inherits base sample's label (type/gold/should_extract) UNLESS the
noise destroys the signal (e.g. 'short' truncation erases the verb).
"""

from __future__ import annotations
import json
import random
import re
import sys
from pathlib import Path

random.seed(1337)

DATASET_PATH = Path('docs/research/fixtures/rule-first-observer/dataset.json')

# Per-type emoji pool (rough semantic match)
EMOJI_BY_TYPE = {
    'preference': ['❤️', '😍', '👍', '🔥', '✨'],
    'emotion':   ['😔', '😊', '😤', '😭', '🙃'],
    'intent':    ['🎯', '🚀', '📅', '✊'],
    'entity':    ['💼', '🏢', '🎓', '👨‍⚕️'],
    'time':      ['⏰', '📆', '🗓️'],
    'none':      ['🤔', '😐', '❓'],
}

FILLER_EN = [
    "you know,", "I mean,", "like,", "sort of,", "kinda,",
    "to be honest,", "and honestly,", "just saying,", "anyway,"
]
FILLER_ZH = [
    "其实吧", "说实话", "真的", "我跟你说", "对了",
    "哦对了", "怎么说呢", "emmm", "讲真"
]

EN_WORDS_FOR_ZH = ['team', 'meeting', 'deadline', 'project', 'OK', 'report', 'code', 'bug', 'review', 'sync']
ZH_WORDS_FOR_EN = ['加班', '开会', '周末', '老板', '同事', '午饭', '散步', '下班']

CODE_SNIPPETS = [
    "(see `main.py:42`)", "— trace: ERR[0x1b]", "(PR #1234)",
    "curl -X POST /api", "`config.json`", "$ git log",
]


def inject_typos(text: str) -> str:
    """Perturb 5-10% of alpha chars."""
    chars = list(text)
    indices = [i for i, c in enumerate(chars) if c.isalpha() and ord(c) < 128]  # ASCII letters
    if not indices:
        return text
    n = max(1, len(indices) // 12)
    for i in random.sample(indices, min(n, len(indices))):
        op = random.choice(['swap', 'drop', 'double'])
        if op == 'swap' and i + 1 < len(chars):
            chars[i], chars[i + 1] = chars[i + 1], chars[i]
        elif op == 'drop':
            chars[i] = ''
        elif op == 'double':
            chars[i] = chars[i] + chars[i]
    return ''.join(chars)


def inject_emoji(text: str, typ: str) -> str:
    pool = EMOJI_BY_TYPE.get(typ, ['😀', '✨'])
    emoji = random.choice(pool)
    pos = random.choice(['end', 'middle'])
    if pos == 'end' or len(text) < 20:
        return text.rstrip(' .!?') + ' ' + emoji
    mid = len(text) // 2
    # Insert at next space boundary
    space = text.find(' ', mid)
    if space < 0:
        return text + ' ' + emoji
    return text[:space] + ' ' + emoji + text[space:]


def inject_code(text: str) -> str:
    snippet = random.choice(CODE_SNIPPETS)
    return text.rstrip(' .!?') + ' ' + snippet


def truncate_short(text: str) -> str:
    words = text.split()
    # Keep only first 2-3 words
    n = random.choice([2, 3])
    return ' '.join(words[:n])


def pad_long(text: str, lang: str) -> str:
    filler_pool = FILLER_ZH if lang == 'zh' else FILLER_EN
    # Prepend 2 fillers, append 2 fillers
    prefix = ' '.join(random.sample(filler_pool, k=min(2, len(filler_pool))))
    suffix = ' '.join(random.sample(filler_pool, k=min(2, len(filler_pool))))
    # For zh, no spaces
    if lang == 'zh':
        return prefix + text + suffix
    return prefix + ' ' + text + ' ' + suffix


def mix_lang(text: str, lang: str) -> str:
    if lang == 'en':
        # Inject a zh word
        word = random.choice(ZH_WORDS_FOR_EN)
        words = text.split()
        if len(words) < 2:
            return text + ' ' + word
        pos = random.randint(1, len(words) - 1)
        words.insert(pos, word)
        return ' '.join(words)
    if lang == 'zh':
        word = random.choice(EN_WORDS_FOR_ZH)
        # Insert near middle
        mid = len(text) // 2
        return text[:mid] + ' ' + word + ' ' + text[mid:]
    return text  # mixed already


def build_variants(samples: list, target_total: int) -> list:
    """Generate noise variants until we reach target_total."""
    out = []
    # Balance: each sample can produce 1-3 variants
    by_type_lang = {}
    for s in samples:
        by_type_lang.setdefault((s['type'], s['language']), []).append(s)

    variant_id_counter = {}

    noise_modes = ['typo', 'emoji', 'code', 'short', 'long', 'mixed-lang']

    # Balanced sampling across (type, lang)
    rounds = 0
    while len(out) < target_total and rounds < 50:
        rounds += 1
        for key, bucket in by_type_lang.items():
            if len(out) >= target_total:
                break
            if not bucket:
                continue
            base = random.choice(bucket)
            mode = random.choice(noise_modes)

            # Skip incompatible combos
            typ = base['type']
            lang = base['language']
            text = base['text']
            if lang == 'mixed' and mode == 'mixed-lang':
                continue
            if mode == 'mixed-lang' and lang not in ('en', 'zh'):
                continue

            # Apply noise
            try:
                if mode == 'typo':
                    new_text = inject_typos(text)
                    should_extract = base['should_extract']
                    gold = base['gold_observation']
                elif mode == 'emoji':
                    new_text = inject_emoji(text, typ)
                    should_extract = base['should_extract']
                    gold = base['gold_observation']
                elif mode == 'code':
                    new_text = inject_code(text)
                    should_extract = base['should_extract']
                    gold = base['gold_observation']
                elif mode == 'short':
                    new_text = truncate_short(text)
                    # Short truncation to 2-3 words almost always destroys the
                    # subject-verb-object triplet — mark as unextractable negative.
                    # Exception: already-negative samples stay negative.
                    should_extract = False
                    gold = None
                    typ = 'none'
                elif mode == 'long':
                    new_text = pad_long(text, lang)
                    should_extract = base['should_extract']
                    gold = base['gold_observation']
                elif mode == 'mixed-lang':
                    new_text = mix_lang(text, lang)
                    should_extract = base['should_extract']
                    gold = base['gold_observation']
                    lang = 'mixed'
                else:
                    continue
            except Exception:
                continue

            # Assign id
            counter_key = (typ, lang)
            variant_id_counter[counter_key] = variant_id_counter.get(counter_key, 0) + 1
            new_id = f"{typ}-{lang}-n{variant_id_counter[counter_key]:03d}"

            # Keep or override trap_reason
            new_trap = base['trap_reason'] if base['trap_reason'] else None
            if typ == 'none' and new_trap is None:
                new_trap = 'noise_destroyed_signal'

            item = {
                'id': new_id,
                'source': 'noise-variant',
                'source_ref': f"noise-of:{base['id']}",
                'text': new_text,
                'language': lang,
                'should_extract': should_extract,
                'type': typ,
                'difficulty': 'noisy',
                'gold_observation': gold,
                'trap_reason': new_trap,
                'noise_features': [mode],
            }
            out.append(item)
    return out


def main():
    with open(DATASET_PATH) as f:
        dataset = json.load(f)

    print(f'Loaded {len(dataset)} base samples')
    target = 320  # push total to ~1040
    variants = build_variants(dataset, target)
    print(f'Generated {len(variants)} noise variants')

    from collections import Counter
    print('by noise type:', Counter(v['noise_features'][0] for v in variants))
    print('by type:', Counter(v['type'] for v in variants))
    print('by lang:', Counter(v['language'] for v in variants))

    merged = dataset + variants
    print(f'\n=== merged total: {len(merged)} ===')
    print('by source:', Counter(x['source'] for x in merged))
    print('by type:', Counter(x['type'] for x in merged))
    print('by lang:', Counter(x['language'] for x in merged))
    print('by diff:', Counter(x['difficulty'] for x in merged))
    print('should_extract:', Counter(x['should_extract'] for x in merged))

    with open(DATASET_PATH, 'w') as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
    print(f'\nwrote {len(merged)} samples to {DATASET_PATH}')


if __name__ == '__main__':
    main()
