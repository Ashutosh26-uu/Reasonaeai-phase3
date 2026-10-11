from modules.m10_interaction.progress import (
    ProgressEvent,
    create_progress_event,
)


def test_progress_event_tracks_attempt_number():
    event = create_progress_event(
        execution_id="exec_001",
        project_id="project_001",
        task_id="task_001",
        status="running",
        message="Retrying execution",
        attempt_number=2,
    )

    assert event.attempt_number == 2
    assert event.project_id == "project_001"
    assert event.task_id == "task_001"


def test_progress_event_supports_escalation():
    event = create_progress_event(
        execution_id="exec_001",
        project_id="project_001",
        task_id="task_001",
        status="escalated",
        message="Escalated for human review",
        attempt_number=3,
    )

    assert event.project_id == "project_001"
    assert event.task_id == "task_001"
    assert event.status == "escalated"
    assert event.attempt_number == 3

def test_progress_event_tracks_attempt_number():
    event = create_progress_event(
        execution_id="exec_001",
        project_id="project_001",
        task_id="task_001",
        status="running",
        message="Retrying execution",
        attempt_number=2,
    )

    assert event.attempt_number == 2
    assert event.project_id == "project_001"
    assert event.task_id == "task_001"


def test_progress_event_supports_escalation():
    event = create_progress_event(
        execution_id="exec_001",
        project_id="project_001",
        task_id="task_001",
        status="escalated",
        message="Escalated for human review",
        attempt_number=3,
    )

    assert event.status == "escalated"
    assert event.attempt_number == 3