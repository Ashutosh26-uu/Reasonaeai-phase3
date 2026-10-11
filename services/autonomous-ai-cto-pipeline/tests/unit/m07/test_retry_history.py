import pytest
from modules.m07_shared_state.retry_history import (
    InMemoryRetryHistoryRepository,
    create_retry_history_record,
)


def test_record_and_retrieve_retry_history():
    repository = InMemoryRetryHistoryRepository()

    record = create_retry_history_record(
        project_id="project_001",
        task_id="task_001",
        execution_id="exec_001",
        attempt_number=1,
        bug_type="name_error",
        decision="retry",
        execution_status="failed",
    )

    repository.record(record)

    history = repository.get_task_history(
        project_id="project_001",
        task_id="task_001",
    )

    assert len(history) == 1
    assert history[0].execution_id == "exec_001"
    assert history[0].attempt_number == 1
    assert history[0].bug_type == "name_error"
    assert history[0].decision == "retry"


def test_history_is_ordered_by_attempt_number():
    repository = InMemoryRetryHistoryRepository()

    repository.record(
        create_retry_history_record(
            project_id="project_001",
            task_id="task_001",
            execution_id="exec_003",
            attempt_number=3,
            bug_type=None,
            decision="stop",
            execution_status="passed",
        )
    )

    repository.record(
        create_retry_history_record(
            project_id="project_001",
            task_id="task_001",
            execution_id="exec_001",
            attempt_number=1,
            bug_type="name_error",
            decision="retry",
            execution_status="failed",
        )
    )

    repository.record(
        create_retry_history_record(
            project_id="project_001",
            task_id="task_001",
            execution_id="exec_002",
            attempt_number=2,
            bug_type="name_error",
            decision="retry",
            execution_status="failed",
        )
    )

    history = repository.get_task_history(
        project_id="project_001",
        task_id="task_001",
    )

    assert [record.attempt_number for record in history] == [1, 2, 3]


def test_get_latest_attempt():
    repository = InMemoryRetryHistoryRepository()

    for attempt in range(1, 4):
        repository.record(
            create_retry_history_record(
                project_id="project_001",
                task_id="task_001",
                execution_id=f"exec_{attempt:03d}",
                attempt_number=attempt,
                bug_type="timeout" if attempt < 3 else None,
                decision="retry" if attempt < 3 else "stop",
                execution_status="failed" if attempt < 3 else "passed",
            )
        )

    latest = repository.get_latest_attempt(
        project_id="project_001",
        task_id="task_001",
    )

    assert latest is not None
    assert latest.attempt_number == 3
    assert latest.execution_id == "exec_003"
    assert latest.execution_status == "passed"


def test_history_is_isolated_between_tasks():
    repository = InMemoryRetryHistoryRepository()

    repository.record(
        create_retry_history_record(
            project_id="project_001",
            task_id="task_001",
            execution_id="exec_001",
            attempt_number=1,
            bug_type="name_error",
            decision="retry",
            execution_status="failed",
        )
    )

    repository.record(
        create_retry_history_record(
            project_id="project_001",
            task_id="task_002",
            execution_id="exec_002",
            attempt_number=1,
            bug_type="timeout",
            decision="retry",
            execution_status="timeout",
        )
    )

    task_one_history = repository.get_task_history(
        project_id="project_001",
        task_id="task_001",
    )

    task_two_history = repository.get_task_history(
        project_id="project_001",
        task_id="task_002",
    )

    assert len(task_one_history) == 1
    assert len(task_two_history) == 1
    assert task_one_history[0].task_id == "task_001"
    assert task_two_history[0].task_id == "task_002"


def test_invalid_attempt_number_is_rejected():
    with pytest.raises(ValueError, match="attempt_number must be >= 1"):
        create_retry_history_record(
            project_id="project_001",
            task_id="task_001",
            execution_id="exec_001",
            attempt_number=0,
            bug_type="name_error",
            decision="retry",
            execution_status="failed",
)

    # The factory itself rejects invalid attempts.
