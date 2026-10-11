"""Safely process a validated API snapshot."""

import json
from pathlib import Path

snapshot_path = Path("/workspace/api_snapshot.json")

if not snapshot_path.is_file():
    raise FileNotFoundError("API snapshot not found")

data = json.loads(snapshot_path.read_text(encoding="utf-8"))

if not isinstance(data, list):
    raise ValueError("Expected API response to be a list")

print("LIVE API SNAPSHOT VERIFIED")
print(f"Records received: {len(data)}")

if data:
    first_record = data[0]
    print(f"First record ID: {first_record.get('id')}")
    print(f"First record title: {first_record.get('title')}")