from modules.m09_qa.bug_classifier import BugReport
from modules.m09_qa.retry_decision import RetryDecisionEngine


def test_retryable_bug_returns_retry():
    engine = RetryDecisionEngine()

    bug = BugReport(
        bug_type="timeout",
        message="Execution timed out",
        retryable=True,
    )

    result = engine.decide(bug, retry_count=0)

    assert result.decision == "retry"
    assert result.retry_count == 1


def test_non_retryable_bug_escalates():
    engine = RetryDecisionEngine()

    bug = BugReport(
        bug_type="syntax_error",
        message="Invalid syntax",
        retryable=False,
    )

    result = engine.decide(bug, retry_count=0)

    assert result.decision == "escalate"


def test_max_retries_escalates():
    engine = RetryDecisionEngine()

    bug = BugReport(
        bug_type="timeout",
        message="Execution timed out",
        retryable=True,
    )

    result = engine.decide(bug, retry_count=3)

    assert result.decision == "escalate"
    assert "Maximum retry" in result.reason


def test_negative_retry_count_rejected():
    engine = RetryDecisionEngine()

    bug = BugReport(
        bug_type="timeout",
        message="Execution timed out",
        retryable=True,
    )

    try:
        engine.decide(bug, retry_count=-1)
        assert False, "Expected ValueError"
    except ValueError:
        pass