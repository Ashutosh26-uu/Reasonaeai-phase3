"""Pure text normalization helpers for M01."""


class InputNormalizationError(ValueError):
    """Raised when input cannot be normalized into meaningful text."""


def normalize_text_value(text: str) -> str:
    """Trim and collapse whitespace, rejecting an empty result."""

    if not isinstance(text, str):
        raise InputNormalizationError("Text input must be a string.")

    normalized = " ".join(text.split())
    if not normalized:
        raise InputNormalizationError("Text input cannot be empty.")
    return normalized
