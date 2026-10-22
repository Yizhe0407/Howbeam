"""Builds the fonts the PDF export embeds (public/fonts/pdf).

Reads the pinned official Noto Sans TC from sources.json, instances the
variable font at Regular and Bold, keeps only the characters the export can
use, renames the result and writes it with the OFL text and a manifest.
Run `python scripts/pdf-fonts/build.py` from the extension directory; see README.md.
"""

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools import version as fonttools_version
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parents[1] / "public" / "fonts" / "pdf"
DEFAULT_CACHE = HERE / ".cache"

FAMILY = "Howbeam Sans TC"
PS_FAMILY = "HowbeamSansTC"
STYLES = {"Regular": 400, "Bold": 700}

# Latin, punctuation, arrows, enclosed numbers, shapes, CJK symbols, kana, bopomofo, fullwidth forms.
EXTRA_RANGES = (
    (0x0020, 0x007E),
    (0x00A0, 0x00FF),
    (0x2010, 0x2027),
    (0x2030, 0x205E),
    (0x2190, 0x21FF),
    (0x2460, 0x24FF),
    (0x25A0, 0x25FF),
    (0x3000, 0x303F),
    (0x3040, 0x30FF),
    (0x3100, 0x312F),
    (0xFF00, 0xFFEF),
)


def big5_level1():
    """The 5,401 most frequently used Traditional characters (Big5 A440-C67E)."""
    characters = []
    for lead in range(0xA4, 0xC7):
        trails = list(range(0x40, 0x7F))
        if lead != 0xC6:
            trails += range(0xA1, 0xFF)
        for trail in trails:
            try:
                characters.append(bytes([lead, trail]).decode("big5"))
            except UnicodeDecodeError:
                pass
    return characters


def wanted_codepoints():
    codepoints = {ord(character) for character in big5_level1()}
    for low, high in EXTRA_RANGES:
        codepoints.update(range(low, high + 1))
    return sorted(codepoints)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(source, name, cache):
    """Downloads one pinned file into the cache and refuses anything that differs from the pin."""
    entry = source["files"][name]
    target = cache / Path(entry["path"]).name
    if not target.exists():
        url = "{}/{}/{}".format(source["rawBase"], source["commit"], urllib.parse.quote(entry["path"]))
        print("downloading", url)
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as response:
            target.write_bytes(response.read())
    data = target.read_bytes()
    if len(data) != entry["bytes"] or sha256(data) != entry["sha256"]:
        raise SystemExit(
            "{} does not match the pin in sources.json (got {} bytes, sha256 {}). "
            "Delete {} and run again, or update the pin deliberately.".format(entry["path"], len(data), sha256(data), target)
        )
    return target


def rename(font, style, weight):
    """Gives the subset its own name. The Reserved Font Name 'Source' is never used, and the
    copyright (0) and license (13, 14) records stay exactly as the OFL requires."""
    table = font["name"]
    table.names = [record for record in table.names if record.nameID in (0, 13, 14)]
    postscript = "{}-{}".format(PS_FAMILY, style)
    version = "Version 2.004; subset for Howbeam"
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        table.setName(FAMILY, 1, platform, encoding, language)
        table.setName(style, 2, platform, encoding, language)
        table.setName("2.004;{}".format(postscript), 3, platform, encoding, language)
        table.setName("{} {}".format(FAMILY, style), 4, platform, encoding, language)
        table.setName(version, 5, platform, encoding, language)
        table.setName(postscript, 6, platform, encoding, language)

    os2 = font["OS/2"]
    os2.usWeightClass = weight
    bold = style == "Bold"
    # fsSelection bit 5 = bold, bit 6 = regular; head.macStyle bit 0 = bold.
    os2.fsSelection = (os2.fsSelection & ~0b1100000) | (0b100000 if bold else 0b1000000)
    font["head"].macStyle = (font["head"].macStyle & ~1) | (1 if bold else 0)


def build_style(source_path, style, weight, codepoints):
    font = TTFont(source_path, recalcTimestamp=False)
    font = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)

    options = subset.Options()
    options.layout_features = ["kern", "ccmp"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.hinting = False
    options.glyph_names = False
    options.drop_tables += ["STAT"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)

    rename(font, style, weight)
    return font


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="where the pinned sources are downloaded")
    args = parser.parse_args()

    source = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    font_path = fetch(source, "font", args.cache)
    license_path = fetch(source, "license", args.cache)
    codepoints = wanted_codepoints()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    outputs = []
    for style, weight in STYLES.items():
        font = build_style(font_path, style, weight, codepoints)
        target = OUTPUT / "{}-{}.ttf".format(PS_FAMILY, style)
        font.save(target)
        data = target.read_bytes()
        outputs.append(
            {
                "file": target.name,
                "family": FAMILY,
                "style": style,
                "weight": weight,
                "glyphs": len(font.getGlyphOrder()),
                "bytes": len(data),
                "sha256": sha256(data),
            }
        )
        print("wrote", target.name, len(data), "bytes")

    license_data = license_path.read_bytes()
    (OUTPUT / "OFL.txt").write_bytes(license_data)

    manifest = {
        "generatedBy": "scripts/pdf-fonts/build.py",
        "fonttools": fonttools_version,
        "source": {"repository": source["repository"], "commit": source["commit"], "files": source["files"]},
        "codepoints": len(codepoints),
        "license": {"file": "OFL.txt", "sha256": sha256(license_data)},
        "fonts": outputs,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
