from dataclasses import dataclass
from typing import Literal

from modules.m09_qa.bug_classifier import BugReport


Decision = Literal["retry", "escalate", "stop"]


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int = 3
    retryable_bug_types: frozenset[str] = frozenset({
        "timeout",
        "import_error",
    })


@dataclass(frozen=True)
class RetryDecision:
    decision: Decision
    retry_count: int
    reason: str


class RetryDecisionEngine:
    def __init__(self, policy: RetryPolicy | None = None):
        self.policy = policy or RetryPolicy()

    def decide(
        self,
        bug: BugReport,
        retry_count: int,
    ) -> RetryDecision:
        if retry_count < 0:
            raise ValueError("retry_count cannot be negative")

        if retry_count >= self.policy.max_retries:
            return RetryDecision(
                decision="escalate",
                retry_count=retry_count,
                reason="Maximum retry limit reached",
            )

        if bug.bug_type not in self.policy.retryable_bug_types:
            return RetryDecision(
                decision="escalate",
                retry_count=retry_count,
                reason=f"Bug type '{bug.bug_type}' is not retryable",
            )

        return RetryDecision(
            decision="retry",
            retry_count=retry_count + 1,
            reason=f"Retry allowed for '{bug.bug_type}'",
        )