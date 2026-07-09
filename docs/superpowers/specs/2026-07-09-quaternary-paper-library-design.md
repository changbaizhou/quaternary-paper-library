# Quaternary Paper Library Design

## Goal

Build a local-first web system for collecting, automatically identifying, classifying, searching, and exporting academic papers for a Quaternary geology graduate workflow.

## Product Scope

The first version is a single-user, single-machine web application. It runs from the local computer, stores PDF files inside its own library folder, and uses SQLite as the database. It does not require accounts, cloud sync, or AI services.

The system may use the network to improve bibliographic metadata. DOI-based lookup uses public scholarly metadata APIs such as Crossref and OpenAlex. If the network is unavailable, the system still stores the PDF and attempts local extraction from the file text.

## First Version Features

- Upload one or more PDF papers from the browser.
- Copy uploaded PDFs into the application's managed `library/files/` directory.
- Extract PDF text locally.
- Detect DOI, title, abstract, author keywords, and basic bibliographic metadata.
- Use DOI lookup to enrich title, authors, journal, year, abstract, and citation metadata.
- Use an internal Quaternary geology taxonomy to suggest classifications.
- Store automatic extraction results as pending drafts.
- Let the user review, edit, and confirm drafts before final library entry.
- Search confirmed papers by title, authors, year, journal, DOI, abstract, keywords, notes, and classification fields.
- Filter by theme, region, period, material, method, proxy, and reading status.
- Maintain a structured paper note card.
- Export confirmed papers as BibTeX, CSV, and Markdown notes.

## Out of Scope for First Version

- User accounts and login.
- Multi-device sync.
- Cloud storage.
- Online AI model calls.
- Local LLM installation.
- Zotero synchronization.
- Full citation graph analysis.
- PDF annotation editing inside the browser.

## Architecture

The application has three layers:

1. A Node.js backend that owns file upload, extraction, metadata enrichment, classification, search, export, and persistence.
2. A SQLite database and managed local file store under `library/`.
3. A static browser UI served by the Node.js backend.

The UI talks to the backend through JSON APIs. The backend is the only layer that reads or writes the database and file store.

## Data Model

### Draft Paper

A draft is created immediately after upload and extraction. It can be confirmed into a final paper record.

Required fields:

- `id`
- `status`
- `original_filename`
- `stored_filename`
- `stored_path`
- `doi`
- `title`
- `authors`
- `journal`
- `year`
- `abstract`
- `author_keywords`
- `suggested_keywords`
- `classification`
- `confidence`
- `evidence`
- `extracted_text`
- `created_at`

### Confirmed Paper

A confirmed paper is the durable library record.

Required fields:

- `id`
- `source_draft_id`
- `stored_filename`
- `stored_path`
- `doi`
- `title`
- `authors`
- `journal`
- `year`
- `abstract`
- `keywords`
- `themes`
- `regions`
- `periods`
- `materials`
- `methods`
- `proxies`
- `reading_status`
- `notes_research_question`
- `notes_region`
- `notes_materials_methods`
- `notes_chronology`
- `notes_core_findings`
- `notes_limits`
- `notes_quote_points`
- `notes_personal`
- `created_at`
- `updated_at`

## Classification Taxonomy

The taxonomy is multi-dimensional. A paper can have multiple values in each dimension.

Initial dimensions:

- Themes: paleoclimate, paleoenvironment, lake sediment, loess, glacier, stratigraphy, chronology, sea level, fluvial terrace, tectonic-climate interaction.
- Regions: Qinghai-Tibet Plateau, Loess Plateau, East Asian monsoon region, Northwest China arid region, Yangtze River basin, North China Plain, coastal shelf, global comparison.
- Periods: Quaternary, Pleistocene, Holocene, Late Quaternary, Last Glacial Maximum, Younger Dryas, MIS stages.
- Materials: lake core, loess section, stalagmite, ice core, marine sediment, fluvial terrace, archaeological site.
- Methods: OSL, radiocarbon, U-series, cosmogenic nuclide, pollen, grain size, magnetic susceptibility, stable isotope, geochemistry, biomarker, remote sensing GIS.
- Proxies: pollen, phytolith, diatom, ostracod, charcoal, grain size, magnetic susceptibility, delta18O, delta13C, TOC, carbonate, elements.

Each taxonomy entry contains Chinese labels, English labels, aliases, and search terms. Classification stores both the suggested label and the matched evidence.

## Extraction Workflow

1. Receive PDF upload.
2. Save the original file into a temporary processing path.
3. Extract text with a local PDF text parser.
4. Detect DOI with a DOI regex.
5. Parse local title, abstract, and keyword candidates.
6. If DOI exists and network is available, query Crossref first and OpenAlex second.
7. Merge metadata with a source priority: DOI metadata, PDF metadata, local text heuristics.
8. Run taxonomy classifier against title, abstract, keywords, and first-page text.
9. Save a draft record with confidence and evidence.
10. Show the draft in the review queue.
11. On confirmation, copy normalized values into the confirmed paper table and index searchable text.

## Error Handling

- If PDF text extraction fails, the upload still creates a draft with an error message and manual fields.
- If DOI lookup fails, local extraction results remain available.
- If duplicate DOI or duplicate stored file hash is detected, the UI warns the user before confirmation.
- If export has no confirmed papers, it returns an empty but valid file.

## User Interface

The first screen is the working library, not a landing page. It contains:

- A left navigation and filter column.
- A central paper list with search.
- A right-side detail/review area.
- An upload panel available from the library view.
- A pending review queue for automatically extracted papers.
- Export controls for BibTeX, CSV, and Markdown.

The UI should be dense, quiet, and research-tool oriented. It should prioritize scanning, filtering, confirming, and editing over decorative presentation.

## Verification

Minimum verification before considering the first version complete:

- DOI extraction tests.
- Abstract and keyword parsing tests.
- Taxonomy classification tests.
- SQLite repository tests.
- API tests for upload, pending draft retrieval, confirmation, paper search, and export.
- Manual browser check that upload, review, confirm, search, and export are usable.
