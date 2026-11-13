"""Preview Plus: temporary preview, on-demand download with optional Comfy workflow."""
import io
import json
import os
import re
import secrets
import string
import logging
import struct
import threading
import time
from pathlib import Path

import folder_paths
from aiohttp import web
from PIL import Image, PngImagePlugin
from server import PromptServer

_LOCK = threading.Lock()
_CACHE = {}
_TTL = 60 * 60 * 3
_LOG = logging.getLogger("PreviewPlus")
_SETTINGS_LOCK = threading.RLock()
_SETTINGS = None


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _literal(value):
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)):
        return None
    return value if isinstance(value, (str, int, float, bool)) else None


def _lookup_node(nodes, ref):
    if isinstance(ref, list) and len(ref) == 2:
        return nodes.get(str(ref[0]), {})
    return {}


def _find_value(nodes, node, keys, depth=0):
    if depth > 3:
        return None
    inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
    for key in keys:
        if key in inputs:
            val = _literal(inputs[key])
            if val is not None:
                return val
    for val in inputs.values():
        upstream = _lookup_node(nodes, val)
        if upstream:
            result = _find_value(nodes, upstream, keys, depth + 1)
            if result is not None:
                return result
    return None


def _parameters(prompt, width, height):
    """Best-effort extraction from Comfy execution graph; never embeds the graph itself."""
    nodes = {str(k): v for k, v in (prompt or {}).items() if isinstance(v, dict)}
    sampler = next((n for n in nodes.values() if "ksampler" in n.get("class_type", "").lower()), {})
    checkpoint = next((n for n in nodes.values() if "checkpointloader" in n.get("class_type", "").lower()), {})
    params = {"Size": f"{width}x{height}"}
    for title, keys in (("Steps", ["steps"]), ("Sampler", ["sampler_name"]),
                        ("Scheduler", ["scheduler"]), ("CFG", ["cfg"]),
                        ("Seed", ["seed", "noise_seed"]), ("Denoise", ["denoise"])):
        val = _find_value(nodes, sampler, keys)
        if val is not None:
            params[title] = val
    model = _find_value(nodes, checkpoint, ["ckpt_name"])
    if model is None:
        model = next((_literal(n.get("inputs", {}).get("unet_name")) for n in nodes.values()
                      if "unetloader" in n.get("class_type", "").lower()), None)
    if model:
        params["Model"] = model
    # Trace KSampler conditioning inputs, then text nodes, rather than blindly
    # assigning arbitrary text inputs in unrelated nodes.
    for key, title in (("positive", "Prompt"), ("negative", "Negative prompt")):
        start = sampler.get("inputs", {}).get(key)
        found = _find_value(nodes, _lookup_node(nodes, start), ["prompt", "text", "text_g", "text_l", "positive_prompt", "negative_prompt"])
        if found is not None:
            params[title] = str(found)
    return params


def _forge_text(params):
    """Forge/A1111-style text. Put Steps first and Size last for existing readers."""
    positive = str(params.get("Prompt", ""))
    negative = str(params.get("Negative prompt", ""))
    order = ("Steps", "Sampler", "Scheduler", "CFG", "Seed", "Denoise", "Model", "Size")
    names = {"Scheduler": "Schedule type", "CFG": "CFG scale"}
    rest = ", ".join(f"{names.get(k, k)}: {params[k]}" for k in order if k in params)
    return positive + ("\nNegative prompt: " + negative if negative else "") + ("\n" + rest if rest else "")


def _clean_cache():
    now = time.time()
    with _LOCK:
        expired = [k for k, v in _CACHE.items() if now - v["time"] > _TTL]
        for k in expired:
            _CACHE.pop(k, None)


def _exif_user_comment_undefined(exif_bytes):
    """Pillow defaults to TIFF BYTE (1) for 0x9286 bytes in a nested IFD.

    Forge uses piexif, whose UserComment reader requires TIFF UNDEFINED (7).
    Patch only the EXIF tag *type*, preserving all image data and offsets.
    """
    buf = bytearray(exif_bytes)
    if not buf.startswith(b"Exif\x00\x00") or len(buf) < 14:
        raise ValueError("Invalid Pillow EXIF header")
    tiff = 6
    marker = bytes(buf[6:8])
    order = "<" if marker == b"II" else ">" if marker == b"MM" else None
    if order is None:
        raise ValueError("Invalid EXIF byte order")

    def read_ifd(off):
        if off < 0 or tiff + off + 2 > len(buf):
            raise ValueError("Invalid EXIF IFD offset")
        count = struct.unpack_from(order + "H", buf, tiff + off)[0]
        start = tiff + off + 2
        if start + count * 12 > len(buf):
            raise ValueError("Truncated EXIF IFD")
        return [start + 12*i for i in range(count)]

    root_offset = struct.unpack_from(order + "I", buf, tiff + 4)[0]
    sub_offset = None
    for entry in read_ifd(root_offset):
        if struct.unpack_from(order + "H", buf, entry)[0] == 0x8769:
            sub_offset = struct.unpack_from(order + "I", buf, entry + 8)[0]
            break
    if sub_offset is None:
        raise ValueError("Missing EXIF SubIFD")
    for entry in read_ifd(sub_offset):
        if struct.unpack_from(order + "H", buf, entry)[0] == 0x9286:
            struct.pack_into(order + "H", buf, entry + 2, 7)  # UNDEFINED
            return bytes(buf)
    raise ValueError("Missing EXIF UserComment")

# A JPEG APP1/EXIF segment cannot exceed 65,533 bytes. Large workflow
# graphs are therefore stored losslessly in extra JPEG APP15 segments while
# ordinary human-readable EXIF remains compatible with existing viewers.
_JPEG_EXIF_LIMIT = 65533
_JPEG_GRAPH_MARKER = b"PreviewPlusGraph\x00\x01"  # signature + protocol version
_JPEG_GRAPH_CHUNK = 60000


def _jpeg_graph_segments(graph):
    """Serialize complete Comfy graph as separate, valid JPEG APP15 segments.

    The bundled JS importer recognizes this container. Each JPEG segment has
    its own 16-bit length; using multiple segments removes the APP1 limit for
    workflow data without changing or truncating a single graph property.
    """
    payload = _json(graph).encode("utf-8")
    count = max(1, (len(payload) + _JPEG_GRAPH_CHUNK - 1) // _JPEG_GRAPH_CHUNK)
    if count > 65535:
        raise ValueError("PreviewPlus JPG workflow exceeds chunk index range")
    segments = []
    for number in range(count):
        chunk = payload[number * _JPEG_GRAPH_CHUNK:(number + 1) * _JPEG_GRAPH_CHUNK]
        content = _JPEG_GRAPH_MARKER + struct.pack(">HH", number, count) + chunk
        segments.append(b"\xff\xef" + struct.pack(">H", len(content) + 2) + content)
    return b"".join(segments)


def _jpeg_embed_graph(jpeg_data, graph):
    if not jpeg_data.startswith(b"\xff\xd8"):
        raise ValueError("Invalid JPEG from image encoder")
    return jpeg_data[:2] + _jpeg_graph_segments(graph) + jpeg_data[2:]


def _config_path():
    # Keep this outside custom_nodes: reinstalling/updating the extension must
    # not reset the user's setting. This location is shared by all workflows.
    get_user = getattr(folder_paths, "get_user_directory", None)
    base = Path(get_user() if callable(get_user) else Path(folder_paths.get_output_directory()).parent / "user")
    return base / "preview_plus" / "settings.json"


def _default_output():
    return str(Path(folder_paths.get_output_directory()).resolve())


def _load_settings():
    global _SETTINGS
    with _SETTINGS_LOCK:
        if _SETTINGS is None:
            _SETTINGS = {"auto_save": False, "output_directory": ""}
            try:
                stored = json.loads(_config_path().read_text(encoding="utf-8"))
                if isinstance(stored, dict):
                    if isinstance(stored.get("auto_save"), bool):
                        _SETTINGS["auto_save"] = stored["auto_save"]
                    if isinstance(stored.get("output_directory"), str):
                        _SETTINGS["output_directory"] = stored["output_directory"]
            except FileNotFoundError:
                pass
            except Exception:
                _LOG.exception("Could not read Preview Plus settings; using defaults")
        return dict(_SETTINGS)


def _public_settings():
    settings = _load_settings()
    settings["effective_directory"] = settings["output_directory"] or _default_output()
    return settings


def _store_settings(settings):
    # Write atomically to avoid truncated config on restart / power loss.
    global _SETTINGS
    with _SETTINGS_LOCK:
        path = _config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
        try:
            tmp.write_text(_json(settings), encoding="utf-8")
            os.replace(tmp, path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        _SETTINGS = dict(settings)
    return _public_settings()


def _validate_directory(path):
    if not isinstance(path, str) or len(path) > 2048 or "\x00" in path:
        raise ValueError("Invalid folder path")
    if not path.strip():
        return ""  # Dynamic default ComfyUI output folder
    target = Path(os.path.expandvars(os.path.expanduser(path.strip()))).resolve()
    if not target.is_dir():
        raise ValueError("Folder does not exist: " + str(target))
    return str(target)


@PromptServer.instance.routes.get("/preview_plus/settings")
async def preview_plus_get_settings(request):
    return web.json_response(_public_settings())


@PromptServer.instance.routes.post("/preview_plus/settings")
async def preview_plus_set_settings(request):
    try:
        values = await request.json()
        if not isinstance(values, dict):
            raise ValueError("Expected a JSON object")
        with _SETTINGS_LOCK:
            settings = _load_settings()
            if "auto_save" in values:
                if not isinstance(values["auto_save"], bool):
                    raise ValueError("auto_save must be true or false")
                settings["auto_save"] = values["auto_save"]
            if "output_directory" in values:
                settings["output_directory"] = _validate_directory(values["output_directory"])
            # Check write permission without creating a dummy image. If the
            # target is unwritable, execution reports the actual filesystem error.
            return web.json_response(_store_settings(settings))
    except (ValueError, TypeError) as exc:
        raise web.HTTPBadRequest(text=str(exc))


def _windows_known_folder(guid):
    """Resolve Windows known folders, respecting OneDrive and relocated libraries.

    Uses Windows Known Folder API instead of assuming C:\\Users\\name\\Documents.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        import uuid

        class _GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8),
            ]

        folder_id = _GUID.from_buffer_copy(uuid.UUID(guid).bytes_le)
        target = ctypes.c_wchar_p()
        shell32 = ctypes.windll.shell32
        shell32.SHGetKnownFolderPath.argtypes = [
            ctypes.POINTER(_GUID), ctypes.c_uint32,
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p),
        ]
        shell32.SHGetKnownFolderPath.restype = ctypes.c_long
        ctypes.windll.ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.ole32.CoTaskMemFree.restype = None
        hr = shell32.SHGetKnownFolderPath(ctypes.byref(folder_id), 0, None,
                                           ctypes.byref(target))
        try:
            return Path(target.value) if hr == 0 and target.value else None
        finally:
            if target.value:
                ctypes.windll.ole32.CoTaskMemFree(ctypes.cast(target, ctypes.c_void_p))
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def _quick_access_folders():
    """Human-friendly locations for the folder picker, on the ComfyUI host."""
    home = Path.home()
    names = ("Desktop", "Downloads", "Documents", "Pictures")
    # Known Folder IDs are stable across Windows languages and account redirects.
    ids = {
        "Desktop": "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
        "Downloads": "374DE290-123F-4565-9164-39C4925E467B",
        "Documents": "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
        "Pictures": "33E28130-4E1E-4676-835A-98395C3BC3BB",
    }
    results = []
    for name in names:
        target = _windows_known_folder(ids[name]) if os.name == "nt" else None
        if target is None and os.name != "nt":
            # Standard XDG user directories can be customized by Linux users.
            try:
                config = (home / ".config" / "user-dirs.dirs").read_text(encoding="utf-8")
                key = "XDG_" + name.upper() + "_DIR"
                found = re.search(r"(?m)^\s*" + re.escape(key) + r'="([^"]+)"', config)
                if found:
                    target = Path(found.group(1).replace("$HOME", str(home)))
            except (OSError, UnicodeError):
                pass
        target = target or home / name
        try:
            target = target.expanduser().resolve()
            if target.is_dir():
                results.append({"label": name, "path": str(target)})
        except OSError:
            pass

    for label, location in (("Home", home),):
        try:
            location = Path(location).expanduser().resolve()
            if location.is_dir():
                results.append({"label": label, "path": str(location)})
        except OSError:
            pass
    return results


@PromptServer.instance.routes.get("/preview_plus/folders")
async def preview_plus_folders(request):
    # Folder-only browser for selecting a directory on the ComfyUI server;
    # it never exposes file contents or file names.
    requested = request.query.get("path") or _public_settings()["effective_directory"]
    try:
        path = Path(os.path.expandvars(os.path.expanduser(requested))).resolve()
        if not path.is_dir():
            raise ValueError("Folder does not exist")
        folders = []
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        folders.append(entry.name)
                except OSError:
                    continue
        folders.sort(key=str.casefold)
        # Show only folders, cap enumeration for directories with huge counts.
        parent = str(path.parent) if path.parent != path else None
        if os.name == "nt":
            roots = [f"{drive}:\\" for drive in string.ascii_uppercase
                     if Path(f"{drive}:\\").is_dir()]
        else:
            roots = ["/"]
        return web.json_response({"path": str(path), "parent": parent,
                                  "folders": folders[:2000], "roots": roots,
                                  "quick_access": _quick_access_folders(),
                                  "truncated": len(folders) > 2000})
    except (OSError, ValueError) as exc:
        raise web.HTTPBadRequest(text=str(exc))


class PreviewPlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "format": (["PNG", "JPG", "WEBP"], {"default": "PNG"}),
            "workflow_json": ("BOOLEAN", {"default": False, "label_on": "Full workflow", "label_off": "Parameters only"}),
        }, "optional": {
            # Connect the exact STRING sent into CLIPTextEncode, including
            # outputs from TextGenerate or prompt switches. Socket only.
            "prompt_text": ("STRING", {"forceInput": True}),
        }, "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ()
    FUNCTION = "preview"
    OUTPUT_NODE = True
    CATEGORY = "image/Preview Plus"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # A save/output node must execute on every queued run, even when all
        # upstream nodes are served from ComfyUI's execution cache.
        return time.time()

    def preview(self, images, format="PNG", workflow_json=False, prompt=None, extra_pnginfo=None,
                unique_id=None, prompt_text=None):
        _clean_cache()
        from PIL import Image
        import numpy as np
        temp_dir = folder_paths.get_temp_directory()
        previews = []
        tokens = []
        auto_settings = _public_settings()
        errors = []
        saved = []
        for index, image in enumerate(images):
            array = (image.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(array)
            token = secrets.token_urlsafe(24)
            filename = f"preview_plus_{token}.png"
            pil.save(os.path.join(temp_dir, filename), format="PNG")
            params = _parameters(prompt, pil.width, pil.height)
            # The execution graph contains references to dynamically produced
            # text, not the final STRING. An optional live input solves that.
            if prompt_text is not None:
                params["Prompt"] = str(prompt_text)
            item = {"path": filename, "params": params, "prompt": prompt or {},
                    "extra": extra_pnginfo or {}, "time": time.time()}
            with _LOCK:
                _CACHE[token] = item
            previews.append({"filename": filename, "subfolder": "", "type": "temp"})
            tokens.append(token)
            if auto_settings["auto_save"]:
                try:
                    saved.append(_save_automatically(item, format, workflow_json,
                                                     auto_settings["effective_directory"]))
                except Exception as exc:
                    _LOG.exception("Auto-save failed for image %s", index + 1)
                    errors.append(f"Image {index + 1}: {exc}")
        return {"ui": {"images": previews, "preview_plus": [{"tokens": tokens,
                "format": format, "workflow_json": workflow_json,
                "auto_save": auto_settings["auto_save"],
                "saved": saved, "errors": errors}]}}


def _render_image(item, fmt, full):
    """Same PNG/JPG/WEBP bytes in manual and automatic save modes."""
    fmt = fmt.upper()
    if fmt not in ("PNG", "JPG", "WEBP"):
        raise ValueError("Unsupported format")
    temp_dir = Path(folder_paths.get_temp_directory()).resolve()
    path = (temp_dir / item["path"]).resolve()
    if path.parent != temp_dir or not path.is_file():
        raise FileNotFoundError("Temporary preview is missing")
    params = item["params"]
    metadata = _forge_text(params)
    # PNG JSON OFF: no `parameters`, `prompt`, or `workflow` PNG chunks.
    # ComfyUI imports A1111 `parameters` as an automatically synthesized graph.
    # Store the same readable values under our own keys instead; PixMeta can
    # display them without triggering import. PNG JSON ON includes the standard
    # keys for Forge and ComfyUI's original workflow restore.
    payload = {"preview_plus_infotext": metadata, "preview_plus_parameters": _json(params)}
    if full:
        payload["parameters"] = metadata
        payload["prompt"] = _json(item["prompt"])
        for key, value in item["extra"].items():
            payload[str(key)] = _json(value)
    output = io.BytesIO()
    with Image.open(path) as src:
        image = src.copy()
    if fmt == "PNG":
        info = PngImagePlugin.PngInfo()
        for key, value in payload.items():
            info.add_text(key, value)
        image.save(output, format="PNG", pnginfo=info, compress_level=6)
        mime, extension = "image/png", "png"
    else:
        exif = Image.Exif()
        # Human-readable A1111 parameters stay in EXIF UserComment for
        # Forge/PixMeta, independent of the complete Comfy workflow graph.
        exif[0x0131] = "ComfyUI / Preview Plus"
        exif[0x8769] = {0x9286: b"UNICODE\x00" + metadata.encode("utf-16-be")}
        graph = None
        if full:
            graph = dict(item["extra"])
            graph["prompt"] = item["prompt"]
            if fmt == "JPG":
                # Backward compatibility: keep small graphs in the original
                # ImageDescription field. Large graphs move to APP15 chunks.
                exif[0x010E] = json.dumps(
                    graph, ensure_ascii=True, separators=(",", ":"), default=str)
            else:
                # Native ComfyUI WebP metadata: EXIF Make/Model tags. Unlike
                # JPEG APP1, WebP's EXIF RIFF chunk supports large payloads.
                workflow = item["extra"].get("workflow")
                if workflow is not None:
                    exif[0x010F] = "workflow:" + json.dumps(
                        workflow, ensure_ascii=True, separators=(",", ":"), default=str)
                exif[0x0110] = "prompt:" + json.dumps(
                    item["prompt"], ensure_ascii=True, separators=(",", ":"), default=str)

        exif_bytes = _exif_user_comment_undefined(exif.tobytes())
        large_jpeg_graph = False
        if fmt == "JPG" and len(exif_bytes) > _JPEG_EXIF_LIMIT and full:
            # ImageDescription is what made EXIF too large. Move only the full
            # graph into lossless APP15 segments; leave UserComment intact.
            del exif[0x010E]
            exif_bytes = _exif_user_comment_undefined(exif.tobytes())
            large_jpeg_graph = True
        if fmt == "JPG" and len(exif_bytes) > _JPEG_EXIF_LIMIT:
            raise ValueError(
                "PreviewPlus: readable JPEG EXIF parameters exceed the JPEG APP1 limit. "
                "Use PNG or WebP, or shorten the manually connected prompt_text.")
        image = image.convert("RGB")
        if fmt == "JPG":
            image.save(output, format="JPEG", quality=100, subsampling=0, exif=exif_bytes)
            if large_jpeg_graph:
                # The bundled JPG importer restores these graphs on drop.
                output_data = _jpeg_embed_graph(output.getvalue(), graph)
                output = io.BytesIO(output_data)
            mime, extension = "image/jpeg", "jpg"
        else:
            image.save(output, format="WEBP", lossless=True, exif=exif_bytes)
            mime, extension = "image/webp", "webp"
    return output.getvalue(), mime, extension


@PromptServer.instance.routes.get("/preview_plus/download/{token}")
async def preview_plus_download(request):
    token = request.match_info["token"]
    with _LOCK:
        item = _CACHE.get(token)
    if not item or time.time() - item["time"] > _TTL:
        raise web.HTTPNotFound(text="Preview expired; generate again")
    fmt = request.query.get("format", "PNG").upper()
    if fmt not in ("PNG", "JPG", "WEBP"):
        raise web.HTTPBadRequest(text="Unsupported format")
    full = request.query.get("workflow_json", "false").lower() == "true"
    try:
        data, mime, extension = _render_image(item, fmt, full)
    except FileNotFoundError as exc:
        raise web.HTTPNotFound(text=str(exc))
    filename = f"preview_plus_{time.strftime('%Y%m%d_%H%M%S')}.{extension}"
    return web.Response(body=data, content_type=mime,
                        headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                 "Cache-Control": "no-store"})


def _save_automatically(item, fmt, full, output_directory):
    data, _, ext = _render_image(item, fmt, full)
    directory = Path(output_directory or _default_output())
    if not directory.is_dir():
        raise FileNotFoundError("Output folder does not exist: " + str(directory))
    # Never overwrite previous generations, even within the same second.
    # Token is already random and URL-safe; use a short part in the filename.
    stem = f"preview_plus_{time.strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(5)}"
    target = directory / f"{stem}.{ext}"
    with target.open("xb") as dest:
        dest.write(data)
    return str(target)


NODE_CLASS_MAPPINGS = {"PreviewPlus": PreviewPlus}
NODE_DISPLAY_NAME_MAPPINGS = {"PreviewPlus": "PreviewPlus"}
