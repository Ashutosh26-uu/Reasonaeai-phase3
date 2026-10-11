
"""Docker-based execution engine with explicit container cleanup."""

from __future__ import annotations

import logging
import subprocess
import time
import uuid
from pathlib import Path

from modules.m08_sandbox.result import ExecutionResult


logger = logging.getLogger(__name__)


class DockerExecutor:
    def __init__(
        self,
        image: str = "python:3.12-slim",
        timeout_seconds: int = 30,
        memory_limit: str = "128m",
        cpus: str = "0.5",
    ) -> None:
        self.image = image
        self.timeout_seconds = timeout_seconds
        self.memory_limit = memory_limit
        self.cpus = cpus

    def execute(
        self,
        project_path: str | Path,
        command: list[str],
        project_id: str = "local-project",
        task_id: str = "local-task",
    ) -> ExecutionResult:
        execution_id = f"exec_{uuid.uuid4().hex[:12]}"
        container_name = f"mindx-exec-{uuid.uuid4().hex[:8]}"

        project_path = Path(project_path).resolve()

        if not project_path.is_dir():
            raise ValueError(f"Project directory not found: {project_path}")

        if not command:
            raise ValueError("Command cannot be empty")

        started_at = time.time()

        logger.info(
            "execution_started execution_id=%s project_id=%s task_id=%s command=%s",
            execution_id,
            project_id,
            task_id,
            command,
        )

        docker_create_command = [
            "docker",
            "create",
            "--name",
            container_name,
            "--network",
            "none",
            "--memory",
            self.memory_limit,
            "--cpus",
            self.cpus,
            "--pids-limit",
            "64",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=16m",
            "--mount",
            f"type=bind,src={project_path},dst=/workspace,readonly",
            "--workdir",
            "/workspace",
            self.image,
            *command,
        ]

        try:
            # 1. Create container.
            create_result = subprocess.run(
                docker_create_command,
                capture_output=True,
                text=True,
                check=False,
            )

            if create_result.returncode != 0:
                logger.error(
                    "container_create_failed execution_id=%s error=%s",
                    execution_id,
                    create_result.stderr.strip(),
                )

                return self._result(
                    execution_id=execution_id,
                    project_id=project_id,
                    task_id=task_id,
                    status="failed",
                    stderr=create_result.stderr,
                    duration_ms=self._duration(started_at),
                    error_type="CONTAINER_CREATE_FAILED",
                )

            logger.info(
                "container_created execution_id=%s container=%s",
                execution_id,
                container_name,
            )

            # 2. Start container.
            start_result = subprocess.run(
                ["docker", "start", container_name],
                capture_output=True,
                text=True,
                check=False,
            )

            if start_result.returncode != 0:
                logger.error(
                    "container_start_failed execution_id=%s error=%s",
                    execution_id,
                    start_result.stderr.strip(),
                )

                return self._result(
                    execution_id=execution_id,
                    project_id=project_id,
                    task_id=task_id,
                    status="failed",
                    stderr=start_result.stderr,
                    duration_ms=self._duration(started_at),
                    error_type="CONTAINER_START_FAILED",
                )

            # 3. Wait for container completion.
            try:
                wait_result = subprocess.run(
                    ["docker", "wait", container_name],
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_seconds,
                    check=False,
                )

                exit_code = int(wait_result.stdout.strip())

                logs_result = subprocess.run(
                    ["docker", "logs", container_name],
                    capture_output=True,
                    text=True,
                    check=False,
                )

                status = "passed" if exit_code == 0 else "failed"
                duration_ms = self._duration(started_at)

                logger.info(
                    "execution_finished execution_id=%s status=%s exit_code=%s duration_ms=%s",
                    execution_id,
                    status,
                    exit_code,
                    duration_ms,
                )

                return self._result(
                    execution_id=execution_id,
                    project_id=project_id,
                    task_id=task_id,
                    status=status,
                    exit_code=exit_code,
                    stdout=logs_result.stdout,
                    stderr=logs_result.stderr,
                    duration_ms=duration_ms,
                )

            except subprocess.TimeoutExpired:
                logger.warning(
                    "execution_timeout execution_id=%s container=%s",
                    execution_id,
                    container_name,
                )

                # 4. Kill timed-out container.
                subprocess.run(
                    ["docker", "kill", container_name],
                    capture_output=True,
                    text=True,
                    check=False,
                )

                return self._result(
                    execution_id=execution_id,
                    project_id=project_id,
                    task_id=task_id,
                    status="timeout",
                    duration_ms=self._duration(started_at),
                    error_type="TIMEOUT",
                )

        finally:
            # 5. Always remove the container.
            cleanup_result = subprocess.run(
                ["docker", "rm", "-f", container_name],
                capture_output=True,
                text=True,
                check=False,
            )

            if cleanup_result.returncode == 0:
                logger.info(
                    "container_cleanup execution_id=%s container=%s",
                    execution_id,
                    container_name,
                )
            else:
                logger.warning(
                    "container_cleanup_failed execution_id=%s container=%s error=%s",
                    execution_id,
                    container_name,
                    cleanup_result.stderr.strip(),
                )

    @staticmethod
    def _duration(started_at: float) -> int:
        return int((time.time() - started_at) * 1000)

    @staticmethod
    def _result(
        execution_id: str,
        project_id: str,
        task_id: str,
        status: str,
        exit_code: int | None = None,
        stdout: str = "",
        stderr: str = "",
        duration_ms: int | None = None,
        error_type: str | None = None,
    ) -> ExecutionResult:
        return ExecutionResult(
            execution_id=execution_id,
            project_id=project_id,
            task_id=task_id,
            status=status,
            exit_code=exit_code,
            stdout=stdout or "",
            stderr=stderr or "",
            duration_ms=duration_ms,
            error_type=error_type,
        )