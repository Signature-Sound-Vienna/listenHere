"""Shared paths for the portrait restyle pipeline (see README.md)."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PORTRAITS = os.path.join(REPO, "app", "static", "exhibit", "portraits")
SOURCES = os.path.join(PORTRAITS, "sources.json")
FACTS = os.path.join(HERE, "sitters.json")
PROMPTS = os.path.join(HERE, "prompts")
LOG = os.path.join(HERE, "renders.jsonl")          # committed: every render's full recipe
WORK = os.path.join(REPO, "tools", ".cache", "portrait-restyle")  # gitignored: pixels
ORIGINALS = os.path.join(WORK, "originals")
INPUTS = os.path.join(WORK, "inputs")
OUT = os.path.join(WORK, "out")
SHEETS = os.path.join(WORK, "sheets")
COMFY = os.path.expanduser("~/ComfyUI")


def sitters():
    """Slugs that have a photograph (placeholders have file null and are never restyled)."""
    src = json.load(open(SOURCES, encoding="utf-8"))["conductors"]
    return [k for k, v in src.items() if v.get("file")]
