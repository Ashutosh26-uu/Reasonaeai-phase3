from modules.m09_qa.bug_classifier import classify_bug


def test_classifies_syntax_error():
    report = classify_bug(
        "  File 'main.py', line 1\nSyntaxError: invalid syntax"
    )

    assert report.bug_type == "syntax_error"
    assert report.retryable is False


def test_classifies_name_error():
    report = classify_bug(
        "Traceback...\nNameError: name 'x' is not defined"
    )

    assert report.bug_type == "name_error"


def test_classifies_timeout():
    report = classify_bug(
        stderr="",
        error_type="TIMEOUT",
    )

    assert report.bug_type == "timeout"
    assert report.retryable is True