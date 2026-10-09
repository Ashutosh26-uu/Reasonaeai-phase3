from dataclasses import dataclass
from typing import Literal

from modules.m09_qa.bug_classifier import BugReport


RepairPriority = Literal["high", "medium"]


@dataclass(frozen=True)
class RepairTask:
    repair_task_id: str
    parent_task_id: str
    project_id: str
    attempt_number: int
    bug_type: str
    error_message: str
    traceback: str
    repair_instructions: str
    priority: RepairPriority


class RepairTaskGenerator:
    """Converts a QA BugReport into a deterministic repair task."""

    _PRIORITIES = {
        "syntax_error": "high",
        "name_error": "high",
        "type_error": "high",
        "import_error": "high",
        "runtime_error": "high",
        "timeout": "high",
        "unknown": "medium",
    }

    _INSTRUCTIONS = {
        "syntax_error": (
            "Fix the syntax error reported by QA, "
            "then rerun the task."
        ),
        "name_error": (
            "Fix the undefined name reported by QA, "
            "then rerun the task."
        ),
        "type_error": (
            "Fix the type mismatch reported by QA, "
            "then rerun the task."
        ),
        "import_error": (
            "Fix the missing or invalid import reported by QA, "
            "then rerun the task."
        ),
        "runtime_error": (
            "Fix the runtime error reported by QA, "
            "then rerun the task."
        ),
        "timeout": (
            "Investigate the execution timeout, reduce or correct "
            "the blocking operation, then rerun the task."
        ),
        "unknown": (
            "Investigate the reported failure using the QA error "
            "message and traceback, then fix the issue and rerun "
            "the task."
        ),
    }

    def generate(
        self,
        bug: BugReport,
        project_id: str,
        parent_task_id: str,
        attempt_number: int,
    ) -> RepairTask:
        """Generate a deterministic repair task from a QA bug."""

        if not project_id.strip():
            raise ValueError("project_id must not be empty")

        if not parent_task_id.strip():
            raise ValueError("parent_task_id must not be empty")

        if attempt_number < 1:
            raise ValueError("attempt_number must be >= 1")

        if not bug.message.strip():
            raise ValueError("BugReport message must not be empty")

        bug_type = bug.bug_type

        priority = self._PRIORITIES.get(
            bug_type,
            "medium",
        )

        instructions = self._INSTRUCTIONS.get(
            bug_type,
            self._INSTRUCTIONS["unknown"],
        )

        repair_task_id = (
            f"repair_{project_id}_{parent_task_id}_"
            f"attempt_{attempt_number}"
        )

        return RepairTask(
            repair_task_id=repair_task_id,
            parent_task_id=parent_task_id,
            project_id=project_id,
            attempt_number=attempt_number,
            bug_type=bug_type,
            error_message=bug.message,
            traceback=bug.traceback,
            repair_instructions=instructions,
            priority=priority,
        )