"""Classify execution failures into actionable bug categories."""

from typing import Literal

from pydantic import BaseModel


BugType = Literal[
    "syntax_error",
    "name_error",
    "type_error",
    "import_error",
    "runtime_error",
    "timeout",
    "unknown",
]


class BugReport(BaseModel):
    bug_type: BugType
    message: str
    traceback: str = ""
    retryable: bool = False


def classify_bug(
    stderr: str,
    error_type: str | None = None,
) -> BugReport:
    text = stderr.lower()

    if error_type == "TIMEOUT":
        return BugReport(
            bug_type="timeout",
            message="Execution exceeded the configured timeout",
            traceback=stderr,
            retryable=True,
        )

    if "syntaxerror" in text:
        bug_type = "syntax_error"
    elif "nameerror" in text:
        bug_type = "name_error"
    elif "typeerror" in text:
        bug_type = "type_error"
    elif "modulenotfounderror" in text or "importerror" in text:
        bug_type = "import_error"
    elif "traceback" in text:
        bug_type = "runtime_error"
    else:
        bug_type = "unknown"

    return BugReport(
        bug_type=bug_type,
        message=stderr.strip() or "Unknown execution failure",
        traceback=stderr,
        retryable=bug_type in {"timeout", "import_error"},
    )