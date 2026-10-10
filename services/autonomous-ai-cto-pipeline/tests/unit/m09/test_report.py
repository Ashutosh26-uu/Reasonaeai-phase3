
from modules.m09_qa.report import QAReport


def test_successful_qa_report():
    report = QAReport(
        report_id="report_001",
        project_id="project_001",
        task_id="task_001",
        status="passed",
        issues_found=0,
    )

    assert report.status == "passed"
    assert report.issues_found == 0
    assert report.issues == []


def test_failed_qa_report():
    report = QAReport(
        report_id="report_002",
        project_id="project_001",
        task_id="task_002",
        status="failed",
        issues_found=1,
        issues=["Application exited with a non-zero exit code"],
    )

    assert report.status == "failed"
    assert report.issues_found == 1
    assert len(report.issues) == 1