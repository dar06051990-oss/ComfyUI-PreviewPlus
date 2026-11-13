# ComfyUI-PreviewPlus

**PreviewPlus** is a compact image preview and saving node for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). Save PNG, JPEG, or WebP images manually or automatically, with readable generation parameters and optional embedded workflow data.

## Features

- **Three image formats:** PNG and lossless WebP; JPEG with quality 100 and 4:4:4 subsampling (JPEG remains a lossy format).
- **Manual save:** preview the result and click the diskette icon to download the image through the browser. Nothing is permanently written to `output` by manual downloads.
- **Auto Save:** switch on to save generated images automatically; the diskette becomes a folder icon for selecting the destination.
- **Easy folder picker:** quick access to Desktop, Downloads, Documents, Pictures and Home; navigate other drives or enter a full path. **Default output** resets the destination to ComfyUI's regular `output` folder.
- **Persistent global settings:** Auto Save and its destination survive browser/server restarts, apply across workflows, and are shared by all PreviewPlus nodes in the same ComfyUI installation.
- **Workflow metadata:** choose **Parameters only** or **Full workflow**. Full workflow enables restoring the original graph when re-importing a supported image, including large JPEG workflows stored in segmented APP15 metadata.
- **Generated prompt:** optional `prompt_text` STRING input lets PreviewPlus record the final output of `TextGenerate` or any prompt switch in PNG/JPG/WebP short metadata.
- **Useful metadata:** best-effort extraction of prompts, negative prompts, seed, steps, sampler, scheduler, CFG, denoise, checkpoint and size. Includes prompts from **ComfyUI-PromptLora**.
- **Compatibility:** readable generation parameters in Forge Neo PNG Info and PixMeta; a JPEG drag-and-drop importer for embedded ComfyUI workflows.

## Installation

1. Go to the `custom_nodes` folder of your ComfyUI installation.
2. Clone this repository:

   ```bash
   git clone https://github.com/dar06051990-oss/ComfyUI-PreviewPlus.git
   ```

   Alternatively, download the repository as ZIP from GitHub and extract the `ComfyUI-PreviewPlus` folder into `ComfyUI/custom_nodes/`.
3. Restart ComfyUI and refresh the browser (`Ctrl+F5` if needed).
4. Add the node **PreviewPlus** from `image / Preview Plus`, then connect its **images** input to your generated image output.

No separate `pip install` is normally needed; the node uses ComfyUI's existing Python environment (including Pillow and NumPy).

## Controls

| Control | Behavior |
| --- | --- |
| `format` | `PNG`, `JPG`, or `WEBP` |
| `workflow_json` | **Parameters only**: no original workflow saved. **Full workflow**: original graph embedded. |
| `prompt_text` (optional socket) | Connect the final STRING used for image conditioning (e.g. TextGenerate or ComfySwitchNode). Its live text is recorded as the positive prompt. |
| `Auto Save` | OFF by default; when ON, saves images immediately after node execution. |
| Diskette icon | Download manually (visible only with Auto Save OFF). |
| Folder icon | Choose the automatic save directory (visible only with Auto Save ON). |

When Auto Save is enabled, the destination defaults to the **current ComfyUI output folder**, not a hard-coded installation path. A different destination can be selected in the folder picker. The directory must already exist and be writable by ComfyUI.

Settings are kept at `<ComfyUI user directory>/preview_plus/settings.json` rather than in the extension folder. These settings are **global to the installation**; a second ComfyUI installation has its own settings.

## Saving and restoring metadata

| Format | Parameters only | Full workflow |
| --- | --- | --- |
| PNG | Readable generation parameters; no original graph | Parameters and original ComfyUI workflow |
| JPG | Readable EXIF generation parameters; no original graph | Parameters and workflow (small graphs in EXIF; large graphs in APP15 segments restored by bundled importer) |
| WebP | Readable EXIF generation parameters; no original graph | Parameters and workflow in ComfyUI-compatible EXIF fields |

**Important:** `Parameters only` means that the *original* ComfyUI graph is not embedded. Some tools may reconstruct a generic workflow from plain-text settings; that is not the original graph.

The node embeds information collected from the execution graph. Model-specific parameters, custom sampler implementations and some unusual prompt structures may not be fully represented in the human-readable fields. Full workflow data is the more complete record where supported.

## Publishing to ComfyUI Registry (maintainers)

The repository contains [a GitHub Actions workflow](.github/workflows/publish-registry.yml) that publishes the version in `pyproject.toml` to ComfyUI Registry:

1. In [ComfyUI Registry](https://registry.comfy.org/), generate a publisher API token for the publisher matching `[tool.comfy].PublisherId`.
2. In GitHub, open **Settings > Secrets and variables > Actions > New repository secret**. Set the name to `REGISTRY_ACCESS_TOKEN` and paste the token as the secret value. Never commit or share this token.
3. To publish the existing version for the first time, open **Actions > Publish PreviewPlus to Comfy Registry > Run workflow**, select `main`, and run it.
4. For later releases, bump `[project].version` in `pyproject.toml` and push the change to `main`. The workflow will publish automatically. Publishing a GitHub Release alone does not trigger Registry publication.

Registry versions are immutable: do not rerun a successful publication of the same version.
## Notes

- The image preview uses ComfyUI's temporary directory. **Auto Save OFF** does not create permanent output files from this node.
- JPEG APP1/EXIF has a per-segment size limit. PreviewPlus now writes large full workflows into multiple lossless APP15 blocks. Its bundled JPG drag-and-drop importer restores those graphs; third-party importers might not understand the custom storage. If the human-readable prompt itself exceeds EXIF capacity, use PNG/WebP.
- WebP full workflows are stored in EXIF and are not bound by JPEG's APP1 size limit.
- `prompt_text` is optional, so old workflows still work unchanged. Connect the final output after any prompt switch, not the LLM's system instruction.
- WebP is lossless here; JPEG is encoded at high quality but remains lossy.
- Some Forge Neo versions may print non-fatal EXIF warnings while still displaying metadata.
- Folder selection refers to the **machine running ComfyUI**, not necessarily the web browser's machine. Only use the folder-picker/settings endpoints on ComfyUI installations you trust; do not expose the server directly to the public internet.

## Tested

The PNG/JPG/WebP formats, workflow switch, auto/manual save, and ComfyUI-PromptLora integration were tested on Windows with ComfyUI by the project author. Behavior can vary between ComfyUI versions and frontends.

## Credits

The JPEG workflow import approach was informed by [Amarillys/ComfyUI-JPG-Metadata](https://github.com/Amarillys/ComfyUI-JPG-Metadata) (MIT). Thanks to its author for demonstrating JPEG workflow restoration in ComfyUI.

## License

This project is licensed under the **MIT License**; see [LICENSE](LICENSE).
