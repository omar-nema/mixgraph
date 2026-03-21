"""Shared utilities for the pipeline."""

import re
import unicodedata


def normalize(text: str) -> str:
    """
    Normalize a string for use in track ID generation / fuzzy comparison.

    Applies NFKD unicode normalization, lowercases, strips all
    non-alphanumeric/non-space characters, and collapses whitespace.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    text = text.replace("_", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text
