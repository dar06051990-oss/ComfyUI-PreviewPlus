# ComfyUI-PreviewPlus

**PreviewPlus** is a compact image preview and saving node for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). Save PNG, JPEG, or WebP images manually or automatically, with readable generation parameters and optional embedded workflow data.

## Features

- **Three image formats:** PNG and lossless WebP; JPEG with quality 100 and 4:4:4 subsampling (JPEG remains a lossy format).
- **Manual save:** preview the result and click the diskette icon to download the image through the browser. Nothing is permanently written to `output` by manual downloads.
- **Auto Save:** switch on to save generated images automatically; the diskette becomes a folder icon for selecting the destination.
- **Easy folder picker:** quick access to Desktop, Downloads, Documents, Pictures and Home; navigate other drives or enter a full path. **Default output** resets the destination to ComfyUI's regular `output` folder.
- **Persistent global settings:** Auto Save and its destination survive browser/server restarts, apply across workflows, and are shared by all PreviewPlus nodes in the same ComfyUI installation.
- **Workflow metadata:** choose **Parameters only** or **Full workflow**. Full workflow enables restoring the original graph when re-importing a supported image.
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
| `Auto Save` | OFF by default; when ON, saves images immediately after node execution. |
| Diskette icon | Download manually (visible only with Auto Save OFF). |
| Folder icon | Choose the automatic save directory (visible only with Auto Save ON). |

When Auto Save is enabled, the destination defaults to the **current ComfyUI output folder**, not a hard-coded installation path. A different destination can be selected in the folder picker. The directory must already exist and be writable by ComfyUI.

Settings are kept at `<ComfyUI user directory>/preview_plus/settings.json` rather than in the extension folder. These settings are **global to the installation**; a second ComfyUI installation has its own settings.

## Saving and restoring metadata

| Format | Parameters only | Full workflow |
| --- | --- | --- |
| PNG | Readable generation parameters; no original graph | Parameters and original ComfyUI workflow |
| JPG | Readable EXIF generation parameters; no original graph | Parameters and workflow (via bundled JPEG importer) |
| WebP | Readable EXIF generation parameters; no original graph | Parameters and workflow in ComfyUI-compatible EXIF fields |

**Important:** `Parameters only` means that the *original* ComfyUI graph is not embedded. Some tools may reconstruct a generic workflow from plain-text settings; that is not the original graph.

The node embeds information collected from the execution graph. Model-specific parameters, custom sampler implementations and some unusual prompt structures may not be fully represented in the human-readable fields. Full workflow data is the more complete record where supported.

## Notes

- The image preview uses ComfyUI's temporary directory. **Auto Save OFF** does not create permanent output files from this node.
- JPEG metadata has an EXIF size limit. If a very large workflow cannot be stored in JPEG or WebP EXIF, use PNG or select Parameters only.
- WebP is lossless here; JPEG is encoded at high quality but remains lossy.
- Some Forge Neo versions may print non-fatal EXIF warnings while still displaying metadata.
- Folder selection refers to the **machine running ComfyUI**, not necessarily the web browser's machine. Only use the folder-picker/settings endpoints on ComfyUI installations you trust; do not expose the server directly to the public internet.

## Tested

The PNG/JPG/WebP formats, workflow switch, auto/manual save, and ComfyUI-PromptLora integration were tested on Windows with ComfyUI by the project author. Behavior can vary between ComfyUI versions and frontends.

## Credits

The JPEG workflow import approach was informed by [Amarillys/ComfyUI-JPG-Metadata](https://github.com/Amarillys/ComfyUI-JPG-Metadata) (MIT). Thanks to its author for demonstrating JPEG workflow restoration in ComfyUI.

## License

A project license has **not yet been selected**. The repository owner will specify one before inviting external contributions or redistribution.
