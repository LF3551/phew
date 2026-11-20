"""Makes the light font of the website from the full Recursive font.

The website uses no slant and weights from 400 to 900, so the slant axis is fixed at upright and the weight
axis is narrowed; only Latin, punctuation, and arrows stay. This cuts the font from about 300 KB to 170 KB.
Usage: python3 scripts/site-font.py Recursive_VF.woff2  (needs fonttools and brotli)
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

TARGET = Path(__file__).resolve().parent.parent / "site" / "fonts" / "recursive.woff2"
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + list(range(0x2010, 0x2028))
    + [0x2030, 0x2039, 0x203A, 0x20AC, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2318, 0x2325, 0x21E7]
)


def main(source: str) -> None:
    font = instancer.instantiateVariableFont(TTFont(source), {"slnt": 0, "wght": (400, 900)}, updateFontNames=False)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(TARGET)
    print(f"{TARGET.name}: {TARGET.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(sys.argv[1])
