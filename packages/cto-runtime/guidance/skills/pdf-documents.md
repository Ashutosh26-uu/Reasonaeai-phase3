---
name: pdf-documents
description: "Produce a PDF deliverable in the workspace — report, invoice, chart page, certificate, or a merged, split, or watermarked existing PDF — and verify it without a renderer. Use when the user asks for a PDF, a printable document, a report to send or file, or a PDF export."
---

# PDF documents
Authoring only: produce the file in the project workspace. Do not build download, publish, or delivery plumbing around it.

## Available libraries
The image installs `reportlab`, `pypdf`, `pdfplumber`, `matplotlib`, and `Pillow` — no install step is needed.

| Deliverable | Library |
| --- | --- |
| Paginated report of text, tables, and charts | `reportlab` (`SimpleDocTemplate` + `Paragraph`, `Table`, `PageBreak`) |
| Figures and charts into a PDF | `matplotlib.backends.backend_pdf.PdfPages` |
| Pages built from raster images | `Pillow`: `image.save(path, "PDF", save_all=True, append_images=[…])` |
| Merge, split, rotate, encrypt, watermark | `pypdf` |
| Extract text or tables from an existing PDF | `pdfplumber`; the workspace read surface already extracts plain text |

Plotly cannot write an image or a PDF: `write_image` needs `kaleido`, which is not installed. Use Plotly for an interactive page inside the app and matplotlib for the PDF. Do not add another PDF library — `fpdf2` in particular is LGPL-3.0 and needs an approval decision.

## Author with a plan
- Declare the page size once (`A4` or `letter`) and keep every page identical. matplotlib sizes in inches: A4 is `(8.27, 11.69)`, US Letter `(8.5, 11)`.
- Real content only: no lorem text, no invented totals, no placeholder names. Figures, dates, and currencies must agree with the source data and with the running app.
- Tables: a header row on every page a table continues onto, numbers aligned on their digits, units in the header rather than repeated in every cell.
- Charts: axis labels with units, legible type size, no decoration that carries no data, and the same colour meaning the app uses.
- More than one page needs a footer with the page number and the document's identity.

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

styles = getSampleStyleSheet()

def footer(canvas, doc):
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"Page {doc.page}")

doc = SimpleDocTemplate("report.pdf", pagesize=A4, title="…", author="…")
doc.build(
    [
        Paragraph("Quarterly report", styles["Title"]),
        Spacer(1, 6 * mm),
        Paragraph("Revenue grew 12% quarter over quarter.", styles["BodyText"]),
        Spacer(1, 4 * mm),
        Table(
            [["Region", "Revenue (USD)"], ["North", "1,240,000"], ["South", "880,500"]],
            colWidths=[80 * mm, 40 * mm],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), "#eeeeee"),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.25, "#cccccc"),
            ]),
        ),
    ],
    onFirstPage=footer,
    onLaterPages=footer,
)
```

## reportlab traps
- Never use Unicode sub/superscript characters — the built-in fonts have no such glyphs and they render as solid black boxes. Use `<sub>` / `<super>` inside a `Paragraph`.
- Register a TTF when the text is not Latin-1, or characters are dropped silently.
- Long unbroken strings (ids, URLs, tokens) overflow the frame; break or wrap them.
- `Table` needs an explicit `colWidths` or it ignores your intent and overflows the page.

## Verify without a renderer
The image has no PDF renderer and no `pdftoppm`, so the page cannot be looked at. Check what is checkable and report the gap instead of claiming a visual review:
- Read it back with `pdfplumber` (or the workspace read surface) and confirm the text, its order, the page count, and that every figure matches the source data.
- Confirm every requested section is present: the totals, the table rows, the last page.
- Confirm the file is non-trivial in size and every page carries the expected content.
- State plainly that layout was not visually verified. If the user needs visual confidence, the app can serve the PDF so they can open it.
