"""
Closed-set species registry for the Fish Party recognizer.

There is NO freehand drawing and NO marker. Every guest coloured *inside* one of
12 fixed printed outlines (`templates/<species>.pdf`). So a drawing's
black line-art is literally one of 12 known shapes, just with colour added and
some scan skew/rotation/cutout. Recognition is therefore a *closed-set template
match* over these 12 references — never open-ended "guess the animal".

This module is the single source of truth mapping each template PDF to a stable
species id + a human-friendly display name. To add a new template: drop the PDF
in `templates/`, add a row here, and re-run `build_references.py`.
"""

# template PDF basename (without ".pdf")  ->  (species_id, display_name)
# The PDFs live in templates/ as "<species_id>.pdf".
TEMPLATE_SPECIES = {
    "jellyfish":   ("jellyfish",  "Jellyfish"),
    "turtle":      ("turtle",     "Sea turtle"),
    "seahorse":    ("seahorse",   "Seahorse"),
    "shark":       ("shark",      "Shark"),
    "sea_urchin":  ("sea_urchin", "Sea urchin"),
    "octopus":     ("octopus",    "Octopus"),
    "angelfish":   ("angelfish",  "Angelfish"),
    "crab":        ("crab",       "Crab"),
    "manta_ray":   ("manta_ray",  "Manta ray"),
    "whale":       ("whale",      "Whale"),
    "pufferfish":  ("pufferfish", "Pufferfish"),
    "squid":       ("squid",      "Squid"),
}

# species_id -> display name
DISPLAY_NAME = {sid: name for (sid, name) in TEMPLATE_SPECIES.values()}

# ordered list of species ids (stable)
ROSTER = [sid for (sid, _name) in TEMPLATE_SPECIES.values()]


def display_name(species_id):
    """Human-friendly name for a species id (falls back to the id)."""
    return DISPLAY_NAME.get(species_id, species_id or "unknown")


if __name__ == "__main__":
    import json
    print(json.dumps(
        {sid: name for sid, name in DISPLAY_NAME.items()}, indent=2))
