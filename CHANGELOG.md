# Changelog

## v1.0.1 — Large workflow and generated prompt fix

- Fixed HTTP 413 / TXT download when large full workflows exceeded the 60 KB metadata guard.
- JPEG workflows exceeding EXIF limits now use lossless APP15 segments, restored by the bundled importer.
- WebP stores large workflow metadata without JPEG's APP1 limit.
- Manual Save reports server errors instead of offering TXT downloads.
- Added optional `prompt_text` STRING socket for storing a runtime generated positive prompt.
- Preserved the existing PNG workflow, global Auto Save and node naming.

## v1.0.0 — Initial stable public release

- First stable GitHub release.

## v0.10.2 — Initial public version

- Final node display name **PreviewPlus**; internal identifier stays `PreviewPlus`.
- PNG/JPG/WebP previews and manual image downloads.
- Optional lossless PNG/WebP and high-quality JPEG generation metadata.
- Optional embedded full workflow and drag-and-drop restoration.
- Global persistent Auto Save with a folder picker and Windows known-folder shortcuts.
- Compact UI with an Auto Save switch and contextual folder/diskette icon.
- PromptLora prompt extraction and compatibility with PixMeta/Forge metadata readers.
