"""Fetch and validate data before sandbox execution."""

from pathlib import Path
import json
import requests

API_URL = "https://jsonplaceholder.typicode.com/posts"
OUTPUT_PATH = Path("examples/live_api_app/api_snapshot.json")

MAX_RESPONSE_BYTES = 1_000_000
TIMEOUT_SECONDS = 10


def fetch_snapshot() -> None:
    response = requests.get(
        API_URL,
        timeout=TIMEOUT_SECONDS,
        headers={"Accept": "application/json"},
    )

    response.raise_for_status()

    content_length = len(response.content)

    if content_length > MAX_RESPONSE_BYTES:
        raise ValueError("API response exceeds size limit")

    data = response.json()

    if not isinstance(data, list):
        raise ValueError("Unexpected API response format")

    validated_data = []

    for item in data:
        if not isinstance(item, dict):
            raise ValueError("Invalid record type")

        if "id" not in item or "title" not in item:
            raise ValueError("Required fields are missing")

        validated_data.append(
            {
                "id": item["id"],
                "title": str(item["title"]),
            }
        )

    OUTPUT_PATH.write_text(
        json.dumps(validated_data, indent=2),
        encoding="utf-8",
    )

    print(f"Fetched and validated {len(validated_data)} records")
    print(f"Saved snapshot to: {OUTPUT_PATH}")


if __name__ == "__main__":
    fetch_snapshot()