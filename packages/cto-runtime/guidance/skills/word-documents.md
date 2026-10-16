---
name: word-documents
description: "Produce or edit an editable Word (.docx) deliverable — report, memo, letter, proposal, contract, or template someone else will edit. Use when the user asks for a Word document, an editable or .docx file, a memo, a letter, or a document template."
---

# Word documents
Authoring only: produce an editable `.docx` in the project workspace. Do not build download, publish, or delivery plumbing around it.

| Situation | Path |
| --- | --- |
| A one-off document from a script | `python-docx`, installed in the image — create, open, edit, and save |
| The generated app produces the document | npm `docx` (MIT), declared in that app's `package.json` |
| Editing a document the user supplied | `python-docx` first; fall back to unzipping and editing `word/document.xml` only when its API cannot express the change |
| Reading a `.docx` someone gave you | the workspace read surface already extracts the text |

A `.docx` is a ZIP of XML parts, which is why editing by hand is possible at all — but subtly wrong OOXML produces a file Word refuses to open. Prefer the library.

## Format the document, do not dump text
- Build structure with heading styles, not bold paragraphs. The navigation pane, a table of contents, and assistive technology all read the style, not the font size.
- One heading hierarchy, one body size, and paragraph spacing instead of empty lines for vertical rhythm.
- Tables: a header row marked as a header, deliberate column widths, and never a table as a divider or for layout.
- Lists use the list style, never a literal `•`.
- Explicit page setup and real margins; a footer with page numbers on anything multi-page.
- Real content only: names, dates, totals, and terminology consistent with the rest of the project. A document the user will send out is a product surface, not a code artifact.

```python
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

document = Document()  # or Document("existing.docx") to edit one
document.add_heading("Proposal", level=0)

section = document.sections[0]
section.page_width, section.page_height = Inches(8.5), Inches(11)  # US Letter; A4 is 8.27 × 11.69

document.add_heading("Scope", level=1)
document.add_paragraph("The work covers the three milestones below.")
for item in ("Discovery", "Build", "Handover"):
    document.add_paragraph(item, style="List Bullet")

table = document.add_table(rows=1, cols=2)
table.style = "Table Grid"
header = table.rows[0].cells
header[0].text, header[1].text = "Milestone", "Duration"
for name, weeks in (("Discovery", "2"), ("Build", "6"), ("Handover", "1")):
    cells = table.add_row().cells
    cells[0].text, cells[1].text = name, weeks

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
footer.add_run("Confidential").font.size = Pt(8)

document.save("proposal.docx")
```

## `docx` (npm) traps
Applies when the generated app writes the document rather than a script:
- Page size defaults to A4; set Letter explicitly when that is what the user expects.
- Landscape: pass portrait dimensions plus the orientation flag — the library swaps them.
- Tables need column widths on the table **and** a width on every cell, in DXA, summing to the table width; percentage widths break in Google Docs and other editors.
- Shading must use the clear shading type; solid renders black.
- Images need an explicit type (`png`, `jpg`) and explicit dimensions.
- A page break must sit inside a paragraph, and paragraphs are separate elements — never a `\n` inside a run.
- A table of contents lists only headings that use the built-in heading styles.
- Dot leaders and right-aligned page numbers on one line use a positional tab, not literal dots.

## Verify
- Reopen the produced file with `python-docx` and confirm the headings, table rows, cell text, and figures match the source data.
- Confirm the archive contains the parts a reader needs: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, and every style or relationship part the document references.
- Confirm every relationship in the archive resolves to a part that exists.
- The image has no Word renderer and no converter, so the document cannot be rendered to check layout. Say that plainly instead of claiming a visual review.
