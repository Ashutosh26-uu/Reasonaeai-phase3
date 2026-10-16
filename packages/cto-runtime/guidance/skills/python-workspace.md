---
name: python-workspace
description: "Use the preloaded Python libraries and create compatible project environments only when needed."
---

# Python workspace
Use when Python environment setup, preloaded libraries, or plotting are relevant. This is internal setup guidance, not a progress message.
The runtime preloads NumPy, pandas, FastAPI/Uvicorn, Matplotlib, Seaborn, Plotly, Pillow, openpyxl, and common API/data tooling. It also preloads the document libraries: reportlab, pypdf and pdfplumber for PDF authoring and inspection, and python-docx for Word. Matplotlib uses the headless Agg backend. Use Pillow for ordinary raster inspection/transforms; do not assume OpenCV, notebooks, or deep-learning frameworks are installed.
For a project virtual environment, use python -m venv --system-site-packages .venv so the preloaded libraries remain available. Do not reinstall the baseline as a startup ritual. Serve interactive Plotly output through the selected app preview when useful. Follow the chosen project's stack and verify actual runtime results before describing a usable output.
