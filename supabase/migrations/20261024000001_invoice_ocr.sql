-- ADR-175: one invoice photographed, scanned or saved as a PDF, read in the browser (OCR or the PDF's
-- own text) and checked field by field by the reviewer before upload. Its batch records how it was read.
--
-- Commit gives these rows the `else` branch of `app.commit_import_batch`'s assurance CASE: `verified`.
-- The figures are the reviewer's own statement, ticked against the document beside them, the same
-- standing as figures a reviewer types (ADR-033) — not a model's reading (`pdf_claude` → `inferred`).
alter type public.extraction_method_enum add value if not exists 'ocr';
