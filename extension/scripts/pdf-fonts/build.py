"""Builds the fonts the PDF export embeds (public/fonts/pdf).

Reads the pinned official Noto fonts from sources.json and builds the export's
font chain: Traditional Chinese first, then supplements for the Simplified
Chinese and Japanese characters it lacks, then symbols and monochrome emoji.
Each family is instanced at Regular and Bold where its source varies in weight,
renamed, and written as WOFF2 with the OFL texts and a manifest.
Run `python scripts/pdf-fonts/build.py` from the extension directory; see README.md.
"""

import argparse
import hashlib
import io
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools import version as fonttools_version
from fontTools.ttLib import TTFont, woff2
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parents[1] / "public" / "fonts" / "pdf"
DEFAULT_CACHE = HERE / ".cache"

STYLES = {"Regular": 400, "Bold": 700}
CJK_FEATURES = ["kern", "ccmp"]

# The chain in lookup order. A supplement keeps only the characters no family before it has.
FAMILIES = (
    {"source": "tc", "family": "Howbeam Sans TC", "license": "license-adobe", "features": CJK_FEATURES},
    {"source": "sc", "family": "Howbeam Sans SC", "license": "license-adobe", "features": CJK_FEATURES, "supplement": True},
    {"source": "jp", "family": "Howbeam Sans JP", "license": "license-adobe", "features": CJK_FEATURES, "supplement": True},
    {"source": "symbols", "family": "Howbeam Symbols", "license": "license-symbols", "features": ["*"]},
    {"source": "symbols2", "family": "Howbeam Symbols 2", "license": "license-symbols", "features": ["*"]},
    {"source": "emoji", "family": "Howbeam Emoji", "license": "license-emoji", "features": ["*"]},
)

LICENSE_FILES = {"license-adobe": "OFL.txt", "license-symbols": "OFL-Symbols.txt", "license-emoji": "OFL-Emoji.txt"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(source, key, cache):
    """Downloads one pinned file into the cache and refuses anything that differs from the pin."""
    entry = source["files"][key]
    target = cache / "{}-{}".format(key, Path(entry["path"]).name)
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


def postscript_family(family):
    return family.replace(" ", "")


def rename(font, family, style, weight):
    """Gives the subset its own name. No Reserved Font Name ('Source') is used, and the
    copyright (0) and license (13, 14) records stay exactly as the OFL requires."""
    table = font["name"]
    upstream_version = table.getDebugName(5) or "Version 1.000"
    table.names = [record for record in table.names if record.nameID in (0, 13, 14)]
    postscript = "{}-{}".format(postscript_family(family), style)
    version = "{}; subset for Howbeam".format(upstream_version.split(";")[0])
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        table.setName(family, 1, platform, encoding, language)
        table.setName(style, 2, platform, encoding, language)
        table.setName("{};{}".format(version, postscript), 3, platform, encoding, language)
        table.setName("{} {}".format(family, style), 4, platform, encoding, language)
        table.setName(version, 5, platform, encoding, language)
        table.setName(postscript, 6, platform, encoding, language)

    os2 = font["OS/2"]
    os2.usWeightClass = weight
    bold = style == "Bold"
    # fsSelection bit 5 = bold, bit 6 = regular; head.macStyle bit 0 = bold.
    os2.fsSelection = (os2.fsSelection & ~0b1100000) | (0b100000 if bold else 0b1000000)
    font["head"].macStyle = (font["head"].macStyle & ~1) | (1 if bold else 0)


def build_style(source_path, family, style, weight, codepoints):
    font = TTFont(source_path, recalcTimestamp=False)
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)

    options = subset.Options()
    options.layout_features = family["features"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.hinting = False
    options.glyph_names = False
    options.drop_tables += ["STAT"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)

    rename(font, family["family"], style, weight)
    return font


def woff2_bytes(font):
    """WOFF2 with glyf and loca stored as they are: fontkit, which PDFKit embeds fonts with,
    cannot rebuild loca from the transformed form and fails when it subsets such a font."""
    plain = io.BytesIO()
    font.save(plain)
    plain.seek(0)
    packed = io.BytesIO()
    woff2.compress(plain, packed, transform_tables=set())
    return packed.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="where the pinned sources are downloaded")
    args = parser.parse_args()

    source = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in [*OUTPUT.glob("*.ttf"), *OUTPUT.glob("*.woff2")]:
        stale.unlink()

    covered = set()
    outputs = []
    chain = {style: [] for style in STYLES}
    for family in FAMILIES:
        source_path = fetch(source, family["source"], args.cache)
        upstream = TTFont(source_path, lazy=True)
        available = set(upstream.getBestCmap())
        varies = "fvar" in upstream
        codepoints = sorted(available - covered if family.get("supplement") else available)
        covered |= available

        for style, weight in (STYLES.items() if varies else [("Regular", 400)]):
            font = build_style(source_path, family, style, weight, codepoints)
            target = OUTPUT / "{}-{}.woff2".format(postscript_family(family["family"]), style)
            data = woff2_bytes(font)
            target.write_bytes(data)
            outputs.append(
                {
                    "file": target.name,
                    "family": family["family"],
                    "style": style,
                    "weight": weight,
                    "source": family["source"],
                    "license": LICENSE_FILES[family["license"]],
                    "codepoints": len(font.getBestCmap()),
                    "glyphs": len(font.getGlyphOrder()),
                    "bytes": len(data),
                    "sha256": sha256(data),
                }
            )
            print("wrote", target.name, len(data), "bytes")
        # A family without a Bold serves bold text with its Regular.
        files = {entry["style"]: entry["file"] for entry in outputs if entry["family"] == family["family"]}
        for style in STYLES:
            chain[style].append(files.get(style, files["Regular"]))

    licenses = []
    for key, name in LICENSE_FILES.items():
        data = fetch(source, key, args.cache).read_bytes()
        (OUTPUT / name).write_bytes(data)
        licenses.append({"file": name, "source": key, "sha256": sha256(data)})

    manifest = {
        "generatedBy": "scripts/pdf-fonts/build.py",
        "fonttools": fonttools_version,
        "source": {"repository": source["repository"], "commit": source["commit"], "files": source["files"]},
        "chain": chain,
        "licenses": licenses,
        "fonts": outputs,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
