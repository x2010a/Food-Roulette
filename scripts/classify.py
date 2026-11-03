"""
Guess each place's cuisine and "craving" (rice / noodles / bread / light)
from its OpenStreetMap cuisine tag and, when that's missing, from its name.

Edit the keyword lists below to improve accuracy over time. Patterns are
regular expressions matched against the lower-cased place name.
"""
import re

# ---------------------------------------------------------------- cuisines
CUISINE_LABELS = {
    "cn": "Chinese", "ml": "Malay & Indonesian", "in": "Indian", "th": "Thai",
    "jp": "Japanese", "kr": "Korean", "ws": "Western", "ot": "Others",
}

# OSM cuisine tag values -> cuisine code
CUISINE_TAGS = {
    "cn": {"chinese", "cantonese", "hainanese", "teochew", "hokkien", "sichuan", "szechuan",
           "hakka", "dim_sum", "dumpling", "dumplings", "hot_pot", "hotpot", "taiwanese",
           "hong_kong", "shanghainese", "mala", "zi_char", "peranakan", "chinese_vegetarian"},
    "ml": {"malay", "malaysian", "indonesian", "nasi_padang", "padang", "peranakan", "nyonya", "satay"},
    "in": {"indian", "north_indian", "south_indian", "pakistani", "bangladeshi", "sri_lankan",
           "indian_muslim", "mamak", "biryani", "prata"},
    "th": {"thai"},
    "jp": {"japanese", "ramen", "sushi", "udon", "soba", "donburi", "yakitori", "yakiniku",
           "izakaya", "tonkatsu", "tempura", "okonomiyaki", "takoyaki"},
    "kr": {"korean"},
    "ws": {"western", "american", "burger", "steak_house", "steak", "pizza", "italian", "french",
           "british", "english", "german", "european", "sandwich", "fish_and_chips", "grill",
           "australian", "chicken", "bagel", "pasta"},
    "ot": {"vietnamese", "middle_eastern", "turkish", "lebanese", "mexican", "filipino", "greek",
           "mediterranean", "arab", "arabic", "persian", "peruvian", "brazilian", "ethiopian",
           "burmese", "myanmar", "cambodian", "kebab", "shawarma", "falafel", "tex-mex",
           "latin_american", "spanish", "tapas", "nepalese", "nepali", "russian"},
}

# Place-name keywords -> cuisine code
CUISINE_NAMES = {
    "cn": r"chinese|dim ?sum|dumpling|xiao ?long|hot ?pot|steamboat|\bmala\b|\bma la\b|bak kut teh"
          r"|ban mian|fish ?ball|yong tau foo|\bytf\b|wan ?ton|won ?ton|kway teow|kuey teow"
          r"|zi ?char|zhi ?char|tze ?char|cze ?char|claypot|clay pot|congee|porridge|hong ?kong"
          r"|sichuan|szechuan|chongqing|teochew|cantonese|hainanese|hokkien|hakka|lor mee"
          r"|prawn mee|hor fun|chicken rice|duck rice|roast duck|char siew|\bbao\b|la ?mian"
          r"|crystal jade|din tai fung|tim ho wan|paradise dynasty|putien|haidilao|tsui wah"
          r"|beef noodle|fish soup|economic rice|cai fan|mixed rice|bee ?hoon|carrot cake"
          r"|chwee kueh|popiah|xin wang|soup restaurant",
    "ml": r"\bnasi\b|mee rebus|mee soto|\bsoto\b|satay|\bsate\b|rendang|\bayam\b|penyet|padang"
          r"|warung|mak ?cik|bakso|lontong|\bmalay|indonesia|mee siam|ikan bakar|\blemak\b"
          r"|roti john|pondok|kampong|kampung|selera|istimewa|rumah makan|nusantara|minang"
          r"|bebek|\bmie\b|gado|\bhjh\b|hajjah",
    "in": r"prata|briyani|biryani|biriyani|tandoor|masala|\bdosai?\b|thosai|\bnaan\b|chapatt?i"
          r"|banana leaf|indian|punjab|chettinad|murtabak|muthu|komala|bhavan|saravana|tiffin"
          r"|madras|kerala|bombay|mumbai|delhi|kashmir|bengal|thali|dhaba|tikka|sup kambing"
          r"|mutton soup|mamak|zam ?zam|springleaf",
    "th": r"\bthai\b|tom ?yum|moo ?kata|mookata|pad thai|\bsiam\b|bangkok|\bisaa?n\b|som tam"
          r"|boat noodle|kra ?pow|chiang mai|sukhothai|ayutthaya|sawadee|jim ?jum|\baroy\b|a-roy",
    "jp": r"japan|ramen|sushi|\budon\b|\bsoba\b|donburi|gyudon|katsudon|butadon|kaisendon|oyakodon"
          r"|katsu|izakaya|yakiniku|yakitori|tempura|omakase|teppan|okonomiyaki|takoyaki"
          r"|onigiri|bento|sashimi|unagi|shabu|sukiya|yoshinoya|ajisen|ippudo|ichiran|genki"
          r"|sushiro|pepper lunch|mos burger|ootoya|tonkotsu|gyu-?kaku|nanbantei|tokyo|osaka"
          r"|hokkaido|kyoto",
    "kr": r"korea|kimchi|bibimbap|seoul|busan|tteok|jjajang|k-?bbq|bulgogi|chimaek|jjigae"
          r"|bornga|seorae|kko kko|ah?jumma|\bgogi\b|chicken up|4 ?fingers",
    "ws": r"western|burger|steak|pizza|pasta|\bgrill|bistro|diner|fish ?(&|and) ?chips|italian"
          r"|trattoria|pizzeria|osteria|brasserie|french|american|mcdonald|kfc|subway"
          r"|texas chicken|domino|a&w|carl'?s jr|wendy'?s|shake shack|popeyes|long john"
          r"|astons?|collin'?s|swensen|saizeriya|nando|fish & co|jack'?s place|morganfield"
          r"|\bribs\b|\bwings\b|\bdeli\b|sandwich|brunch|gastropub|\bpub\b|tavern|smoke ?house",
    "ot": r"vietnam|\bpho\b|banh mi|turkish|kebab|shawarma|falafel|lebanese|mexican|\btacos?\b"
          r"|burrito|filipino|jollibee|greek|mediterranean|\barab|persian|middle east|peruvian"
          r"|brazil|ethiopian|burmese|myanmar|cambodian|nepal|russian|spanish|tapas|paella",
}

# ---------------------------------------------------------------- cravings
CRAVING_LABELS = {"r": "Rice", "n": "Noodles", "b": "Bread & burgers", "l": "Light / low-carb"}

CRAVING_TAGS = {
    "r": {"rice", "donburi", "biryani", "chicken_rice", "curry_rice", "nasi_lemak", "nasi_padang",
          "bento", "congee", "porridge", "fried_rice", "claypot", "padang"},
    "n": {"noodle", "noodles", "ramen", "udon", "soba", "pasta", "pho", "laksa", "italian"},
    "b": {"burger", "sandwich", "pizza", "bakery", "bagel", "kebab", "pie", "toast", "prata",
          "kaya_toast", "donut", "waffle", "pancake", "shawarma"},
    "l": {"salad", "poke", "steak_house", "barbecue", "bbq", "hot_pot", "hotpot", "seafood",
          "soup", "yong_tau_foo", "sashimi", "shabu_shabu", "grill", "korean_bbq", "yakiniku",
          "mala", "healthy", "satay"},
}

CRAVING_NAMES = {
    "r": r"\brice\b|\bnasi\b|briyani|biryani|biriyani|claypot|clay pot|bento|donburi|gyudon"
         r"|katsudon|butadon|kaisendon|oyakodon|bibimbap|congee|porridge|cai fan|paella|risotto"
         r"|onigiri|sushi|zi ?char|tze ?char|cze ?char|pepper lunch|sukiya|yoshinoya|padang"
         r"|penyet|\bayam\b|thali|banana leaf",
    "n": r"noodle|ramen|\bmee\b|\bmie\b|\bmian\b|laksa|\bpho\b|\budon\b|\bsoba\b|kway teow"
         r"|kuey teow|kueh teow|hor fun|bee ?hoon|pasta|spaghetti|wan ?ton|won ?ton|pad thai"
         r"|jjajang|la ?mian|tom ?yum|ippudo|ichiran|ajisen|italian|trattoria|saizeriya|mamak",
    "b": r"burger|sandwich|bakery|bread|toast|pizza|prata|\bnaan\b|bagel|croissant|\bkaya\b"
         r"|\bbaos?\b|\bsub\b|subway|\bwraps?\b|kebab|murtabak|\bpies?\b|baguette|boulangerie"
         r"|banh mi|\broti\b|mcdonald|carl'?s jr|wendy'?s|shake shack|a&w|domino|ya kun|killiney"
         r"|bakehouse|patisserie|donut|doughnut|waffle|pancake|brunch|\bdeli\b|\btacos?\b"
         r"|burrito|shawarma|kfc|texas chicken|popeyes|jollibee|4 ?fingers",
    "l": r"salad|\bpoke\b|yong tau foo|\bytf\b|\bmala\b|\bma la\b|hot ?pot|steamboat|shabu|soup"
         r"|sashimi|steak|\bgrill|barbecue|\bbbq\b|yakiniku|yakitori|moo ?kata|mookata|k-?bbq"
         r"|seafood|satay|\bsate\b|a[cç]ai|grain|\bbowls?\b|healthy|keto|\bgreens?\b|sprout"
         r"|ikan bakar|tandoor|tikka|rotisserie|sous vide|gyu-?kaku|nanbantei",
}

# Places with many stalls: they match every cuisine and craving filter.
MIXED_NAMES = re.compile(
    r"food ?cent(re|er)|hawker|food ?court|kopi ?tiam|coffee ?shop|eating house|food ?hall"
    r"|foodfare|food republic|koufu|canteen|\bmarket\b|food ?village|food ?junction|food ?opera"
    r"|food ?paradise|food ?street|makan ?place|food ?garden"
)

_cuisine_re = {k: re.compile(v) for k, v in CUISINE_NAMES.items()}
_craving_re = {k: re.compile(v) for k, v in CRAVING_NAMES.items()}


def _tag_values(cuisine_tag):
    if not cuisine_tag:
        return set()
    return {v.strip().lower().replace(" ", "_") for v in cuisine_tag.split(";") if v.strip()}


def classify(name, cuisine_tag, amenity):
    """Return (cuisine_codes, craving_codes, is_mixed, cuisine_source).

    cuisine_source is "tag", "name" or None (for the coverage report).
    """
    lname = (name or "").lower()
    tags = _tag_values(cuisine_tag)

    mixed = amenity == "food_court" or bool(MIXED_NAMES.search(lname))

    cuisines = {code for code, values in CUISINE_TAGS.items() if tags & values}
    source = "tag" if cuisines else None
    if not cuisines:
        cuisines = {code for code, rx in _cuisine_re.items() if rx.search(lname)}
        source = "name" if cuisines else None

    cravings = {code for code, values in CRAVING_TAGS.items() if tags & values}
    cravings |= {code for code, rx in _craving_re.items() if rx.search(lname)}

    order_c = list(CUISINE_LABELS)
    order_r = list(CRAVING_LABELS)
    return (sorted(cuisines, key=order_c.index), sorted(cravings, key=order_r.index), mixed, source)
