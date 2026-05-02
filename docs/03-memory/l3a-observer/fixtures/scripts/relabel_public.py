"""Re-label PersonaChat + MSC-Self-Instruct samples against our SCHEMA.md."""
import json
import re
import os
from pathlib import Path

FETCH = Path('/tmp/rule-first-observer-fetch')

# Regex heuristics for classification.
RE_PREF = re.compile(r"\bI\s+(like|love|prefer|enjoy|hate|dislike|adore|can't stand|dont like|don't like|am a fan of|am into|favorite)\b", re.I)
RE_EMOTION_WORDS = re.compile(r"\b(exhausted|sad|angry|frustrated|anxious|nervous|scared|lonely|happy|excited|stressed|depressed|bored|tired|overwhelmed)\b", re.I)
RE_INTENT = re.compile(r"\b(I['’]ll|I will|I'm going to|I am going to|I plan to|planning to|I want to|I intend to|I'm about to|I'll be)\b", re.I)
RE_TIME = re.compile(r"\b(tomorrow|yesterday|today|next week|last week|next month|last month|this weekend|every (morning|evening|night|week|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+ (hours?|minutes?|days?|weeks?|months?|years?) (ago|later|from now))\b", re.I)
RE_ENTITY_WORK = re.compile(r"\bI\s+(work|am employed|am a|am an|am working|was a|used to work|have been working)\b", re.I)
RE_ENTITY_FAMILY = re.compile(r"\bI\s+(have|own|live with)\s+(\d+\s+)?(cats?|dogs?|kids?|children|siblings?|brothers?|sisters?)\b", re.I)
RE_ENTITY_LOC = re.compile(r"\bI\s+(live|grew up|was born|am from)\b", re.I)
RE_QUESTION = re.compile(r"\?$")
RE_HOWARE = re.compile(r"\b(how are you|how's it going|what's up|hi there|hello|hey)\b", re.I)


def classify(text: str):
    """Return (type, difficulty, gold_observation, should_extract) or None to skip."""
    t = text.strip()
    if not t or len(t) < 6 or len(t) > 280:
        return None

    # Pure questions / greetings — none
    if RE_HOWARE.search(t) and len(t.split()) < 10:
        return ('none', 'trap', None, False, 'meta_conversation')
    if RE_QUESTION.search(t) and len(t.split()) < 15 and not RE_INTENT.search(t):
        return ('none', 'trap', None, False, 'rhetorical_question' if re.search(r"\b(who|why|how|what)\b", t, re.I) else 'meta_conversation')

    # Preference — very strong signal
    if RE_PREF.search(t):
        # Quote-of-other trap
        if re.search(r"\b(my (mom|dad|friend|wife|husband|partner)|he|she|they)\s+(says?|said|thinks?|loves|likes|hates|prefers)\b", t, re.I) and not re.match(r"^\s*I\b", t):
            return ('none', 'trap', None, False, 'quoted_other')
        # Extract gold — only on clean single-clause "I verb object"
        m = re.search(r"^\s*I\s+(like|love|prefer|enjoy|adore|hate|dislike)\s+([^.,!?;]+)[.!?]?\s*$", t, re.I)
        if m:
            verb, obj = m.group(1).lower(), m.group(2).strip()
            verb_map = {'like': 'Likes', 'love': 'Loves', 'prefer': 'Prefers', 'enjoy': 'Enjoys',
                        'adore': 'Loves', 'hate': 'Dislikes', 'dislike': 'Dislikes'}
            # Avoid over-long gold
            if len(obj.split()) <= 8:
                return ('preference', 'explicit', f"{verb_map.get(verb, 'Likes')} {obj}", True, None)
        # Multi-clause or awkward — skip rather than mis-label
        return None

    # Intent — modal verb present; only keep if short + clean
    if RE_INTENT.search(t):
        m = re.search(r"^\s*I\s*(?:['’]ll| will| am going to| plan to| want to|m going to)\s+([^.,!?;]+)[.!?]?\s*$", t, re.I)
        if m:
            obj = m.group(1).strip()
            if len(obj.split()) <= 8:
                return ('intent', 'explicit', f"Plans to {obj}", True, None)
        return None

    # Emotion
    m = RE_EMOTION_WORDS.search(t)
    if m and re.search(r"\bI\s*(am|'m|feel|was|felt)\b", t, re.I):
        return ('emotion', 'explicit', f"Feels {m.group(1).lower()}", True, None)

    # Entity — work (try several verb forms)
    m_work_at = re.search(r"\bI\s+work\s+(at|for|in)\s+([A-Za-z][^.,!?]{1,60})", t, re.I)
    m_work_as = re.search(r"\bI\s+(?:work\s+as|am|am a|am an|am working as)\s+(a|an|the)?\s*([a-z][a-z\- ]{2,40})", t, re.I)
    if m_work_at:
        return ('entity', 'explicit', f"Works at {m_work_at.group(2).strip()}", True, None)
    if m_work_as and re.search(r"\b(librarian|teacher|engineer|doctor|nurse|waiter|bartender|chef|cook|writer|artist|musician|designer|developer|programmer|lawyer|accountant|farmer|driver|pilot|manager|scientist|student|researcher|stunt double|actor|actress|dancer|photographer|mechanic|plumber|electrician|carpenter|banker|consultant)\b", t, re.I):
        occ_m = re.search(r"\b(librarian|teacher|engineer|doctor|nurse|waiter|bartender|chef|cook|writer|artist|musician|designer|developer|programmer|lawyer|accountant|farmer|driver|pilot|manager|scientist|student|researcher|stunt double|actor|actress|dancer|photographer|mechanic|plumber|electrician|carpenter|banker|consultant)\b", t, re.I)
        return ('entity', 'explicit', f"Works as {occ_m.group(1).lower()}", True, None)
    if RE_ENTITY_WORK.search(t):
        return ('entity', 'implicit', None, True, None)

    # Entity — family/pets
    if RE_ENTITY_FAMILY.search(t):
        m = re.search(r"\bI\s+have\s+(\d+\s+)?(cats?|dogs?|kids?|children|siblings?|brothers?|sisters?)", t, re.I)
        if m:
            qty = (m.group(1) or '').strip()
            thing = m.group(2)
            return ('entity', 'explicit', f"Has {qty + ' ' if qty else ''}{thing}", True, None)
        return ('entity', 'explicit', None, True, None)

    # Entity — location
    if RE_ENTITY_LOC.search(t):
        m = re.search(r"\bI\s+(?:live|grew up|am from)\s+(?:in\s+)?([A-Z][\w ]+)", t)
        if m:
            return ('entity', 'explicit', f"Lives in {m.group(1).strip()}", True, None)
        return ('entity', 'implicit', None, True, None)

    # Time
    if RE_TIME.search(t) and re.search(r"\bI\b", t):
        m = RE_TIME.search(t)
        return ('time', 'explicit', f"Time reference: {m.group(0)}", True, None)

    # Narrow non-extract patterns only — don't mass-mark as none
    # Generic statements with "people usually / everyone / nobody" → generic_statement trap
    if re.search(r"\b(people|everyone|nobody|most folks|some people)\s+(usually|tend to|always|never|like|love|hate|prefer)\b", t, re.I):
        return ('none', 'trap', None, False, 'generic_statement')
    # Hypotheticals — "if I X"
    if re.search(r"^\s*(if|suppose|imagine)\s+I\b", t, re.I):
        return ('none', 'trap', None, False, 'hypothetical')
    # Past-abandoned — "I used to X but not anymore"
    if re.search(r"\bI\s+used to\b.*\b(but|no longer|not anymore|quit|stopped)\b", t, re.I):
        return ('none', 'trap', None, False, 'past_abandoned')
    # Otherwise — skip, don't force a label
    return None


def slugify_ref(base: str, idx: int) -> str:
    return f"{base}:row{idx}"


def next_id(counts, cat, lang):
    key = (cat, lang)
    counts[key] = counts.get(key, 0) + 1
    return f"{cat}-{lang}-{counts[key]:03d}"


def run():
    out = []
    counts = {}
    id_base_offset = 200  # start PersonaChat/MSC ids at 200 to avoid collisions with hand-crafted

    # PersonaChat — use personality lines (each row has ~4 clean statements)
    seen_personality = set()
    pc_files = ['personachat_main_a.json', 'personachat_main_b.json', 'personachat_0.json',
                'personachat_200.json', 'personachat_1000.json', 'personachat_1500.json',
                'personachat_2000.json', 'personachat_2500.json', 'personachat_3000.json']
    for fname in pc_files:
        fpath = FETCH / fname
        if not fpath.exists():
            continue
        with open(fpath) as f:
            d = json.load(f)
        for row in d.get('rows', []):
            r = row.get('row', {})
            conv_id = r.get('conv_id')
            for p in (r.get('personality') or []):
                if p in seen_personality:
                    continue
                seen_personality.add(p)
                cls = classify(p)
                if cls is None:
                    continue
                cat, diff, gold, extract, trap = cls
                item = {
                    'id': next_id(counts, cat, 'en'),
                    'source': 'personachat',
                    'source_ref': f"personachat:conv{conv_id}:personality",
                    'text': p.strip(),
                    'language': 'en',
                    'should_extract': extract,
                    'type': cat,
                    'difficulty': diff,
                    'gold_observation': gold,
                    'trap_reason': trap,
                    'noise_features': None,
                }
                out.append(item)

    # Also mine PersonaChat history turns (dialogue — less clean)
    pc_history_seen = set()
    for fname in pc_files:
        fpath = FETCH / fname
        if not fpath.exists():
            continue
        with open(fpath) as f:
            d = json.load(f)
        for row in d.get('rows', [])[:10]:  # limit history per file
            r = row.get('row', {})
            conv_id = r.get('conv_id')
            for turn in (r.get('history') or []):
                if turn in pc_history_seen:
                    continue
                pc_history_seen.add(turn)
                cls = classify(turn)
                if cls is None:
                    continue
                cat, diff, gold, extract, trap = cls
                out.append({
                    'id': next_id(counts, cat, 'en'),
                    'source': 'personachat',
                    'source_ref': f"personachat:conv{conv_id}:history",
                    'text': turn.strip(),
                    'language': 'en',
                    'should_extract': extract,
                    'type': cat,
                    'difficulty': diff,
                    'gold_observation': gold,
                    'trap_reason': trap,
                    'noise_features': None,
                })

    # MSC-Self-Instruct — persona statements (these are richer multi-sentence)
    msc_files = ['msc_a.json', 'msc_b.json']
    seen_msc = set()
    for fname in msc_files:
        fpath = FETCH / fname
        if not fpath.exists():
            continue
        with open(fpath) as f:
            d = json.load(f)
        for row_idx, row in enumerate(d.get('rows', [])):
            r = row.get('row', {})
            sess = (r.get('metadata') or {}).get('session_id', '?')
            # Flatten MSC personas (list of lists per speaker)
            for speaker_idx, persona_set in enumerate(r.get('personas') or []):
                for p in (persona_set or []):
                    # MSC persona items often contain multiple sentences — split
                    for sent in re.split(r'(?<=[.!?])\s+', p):
                        s = sent.strip()
                        if len(s) < 6 or s in seen_msc:
                            continue
                        seen_msc.add(s)
                        cls = classify(s)
                        if cls is None:
                            continue
                        cat, diff, gold, extract, trap = cls
                        out.append({
                            'id': next_id(counts, cat, 'en'),
                            'source': 'msc',
                            'source_ref': f"msc:session{sess}:speaker{speaker_idx}:row{row_idx}",
                            'text': s,
                            'language': 'en',
                            'should_extract': extract,
                            'type': cat,
                            'difficulty': diff,
                            'gold_observation': gold,
                            'trap_reason': trap,
                            'noise_features': None,
                        })
            # Also sample dialog turns
            for t_idx, turn in enumerate((r.get('dialog') or [])[:6]):
                text = turn.get('text', '').strip()
                if len(text) < 6 or text in seen_msc:
                    continue
                seen_msc.add(text)
                cls = classify(text)
                if cls is None:
                    continue
                cat, diff, gold, extract, trap = cls
                out.append({
                    'id': next_id(counts, cat, 'en'),
                    'source': 'msc',
                    'source_ref': f"msc:session{sess}:dialog{t_idx}",
                    'text': text,
                    'language': 'en',
                    'should_extract': extract,
                    'type': cat,
                    'difficulty': diff,
                    'gold_observation': gold,
                    'trap_reason': trap,
                    'noise_features': None,
                })

    print(f'Generated {len(out)} samples')
    from collections import Counter
    print('by type:', Counter(x['type'] for x in out))
    print('by diff:', Counter(x['difficulty'] for x in out))
    print('by source:', Counter(x['source'] for x in out))
    print('extract:', Counter(x['should_extract'] for x in out))
    return out


def cap_per_type(samples, cap=60):
    """Keep at most `cap` samples per (type, difficulty) combo, randomized by hash of id."""
    from collections import defaultdict
    buckets = defaultdict(list)
    for s in samples:
        buckets[(s['type'], s['difficulty'])].append(s)
    out = []
    # Prefer variety: sample uniformly across source
    for (typ, diff), items in buckets.items():
        # Sort by source so personachat + msc interleave
        items.sort(key=lambda x: (x['source'], x['id']))
        if len(items) <= cap:
            out.extend(items)
        else:
            # Take evenly spaced
            step = len(items) / cap
            picked = [items[int(i * step)] for i in range(cap)]
            out.extend(picked)
    return out


if __name__ == '__main__':
    data = run()
    capped = cap_per_type(data, cap=80)
    # Re-id sequentially
    counts = {}
    for s in capped:
        key = (s['type'], s['language'])
        counts[key] = counts.get(key, 0) + 1
        s['id'] = f"{s['type']}-{s['language']}-p{counts[key]:03d}"  # 'p' prefix = public
    print('\n=== After cap ===')
    from collections import Counter
    print(f'total: {len(capped)}')
    print('by type:', Counter(x['type'] for x in capped))
    print('by diff:', Counter(x['difficulty'] for x in capped))
    print('by source:', Counter(x['source'] for x in capped))
    print('extract:', Counter(x['should_extract'] for x in capped))
    outpath = FETCH / 'public_relabeled.json'
    with open(outpath, 'w') as f:
        json.dump(capped, f, ensure_ascii=False, indent=2)
    print(f'wrote {outpath}')
