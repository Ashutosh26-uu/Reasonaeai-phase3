from modules.m07_shared_state.retry_history import InMemoryRetryHistoryRepository
from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.reliability_coordinator import ReliabilityCoordinator
from modules.m09_qa.repair_handoff import DeterministicImportRepairHandoff
from modules.m09_qa.retry_decision import RetryDecisionEngine, RetryPolicy
from modules.m09_qa.runner import QARunner


def test_self_healing_import_error_retries_to_pass(tmp_path) -> None:
    source_path = tmp_path / "main.py"
    source_path.write_text("import self_healing_missing_module\n", encoding="utf-8")

    history = InMemoryRetryHistoryRepository()
    events = []
    coordinator = ReliabilityCoordinator(
        qa_runner=QARunner(executor=DockerExecutor(timeout_seconds=30)),
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=1)),
        history_repository=history,
        progress_callback=events.append,
        repair_handoff=DeterministicImportRepairHandoff(),
    )

    result = coordinator.run(
        project_path=tmp_path,
        command=["python", "main.py"],
        project_id="self-healing-project",
        task_id="import-error-task",
    )

    assert result.status == "passed"
    assert result.attempts == 2
    assert result.retry_count == 1
    assert result.final_report.status == "passed"
    assert len(result.repair_tasks) == 1
    assert result.repair_tasks[0].bug_type == "import_error"
    assert len(result.handoff_results) == 1
    assert result.handoff_results[0].success is True
    assert source_path.read_text(encoding="utf-8") == (
        'print("SELF_HEALING_IMPORT_REPAIRED")\n'
    )

    history_records = history.get_task_history(
        "self-healing-project", "import-error-task"
    )
    assert [(record.decision, record.execution_status) for record in history_records] == [
        ("retry", "failed"),
        ("stop", "passed"),
    ]
    assert history_records[0].bug_type == "import_error"
    assert history_records[1].bug_type is None

    assert events[0].status == "started"
    assert events[-1].status == "passed"
    assert events[-1].project_id == "self-healing-project"
    assert events[-1].task_id == "import-error-task"
    assert events[-1].attempt_number == 2
