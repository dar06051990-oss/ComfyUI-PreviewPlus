import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Restore ComfyUI graphs from JPG EXIF UserComment. Works with Preview Plus
// and ComfyUI-JPG-Metadata; no dependency on the latter extension.
function jpegUserComment(buffer) {
  const view = new DataView(buffer);
  const end = view.byteLength;
  if (end < 4 || view.getUint16(0) !== 0xffd8) return null;

  function extractTiff(tiff, segmentEnd) {
    if (tiff + 8 > segmentEnd) return null;
    const a = view.getUint8(tiff), b = view.getUint8(tiff + 1);
    if (!((a === 0x49 && b === 0x49) || (a === 0x4d && b === 0x4d))) return null;
    const le = a === 0x49;
    if (view.getUint16(tiff + 2, le) !== 42) return null;
    const read16 = (p) => view.getUint16(p, le);
    const read32 = (p) => view.getUint32(p, le);

    function ifd(offset) {
      const start = tiff + offset;
      if (start < tiff || start + 2 > segmentEnd) return {comment: null, exifOffset: null};
      const count = read16(start);
      if (start + 2 + count * 12 > segmentEnd) return {comment: null, exifOffset: null};
      let exifOffset = null;
      let description = null;
      for (let i = 0; i < count; i++) {
        const entry = start + 2 + i * 12;
        const tag = read16(entry);
        if (tag === 0x8769) exifOffset = read32(entry + 8);
        if (tag !== 0x9286 && tag !== 0x010e) continue;
        const size = read32(entry + 4);
        const position = size <= 4 ? entry + 8 : tiff + read32(entry + 8);
        if (size > 60000 || position < tiff || position + size > segmentEnd) return {comment: null, exifOffset};
        let bytes = new Uint8Array(buffer, position, size);
        if (tag === 0x010e) {
          description = new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "");
          continue;
        }
        const header = Array.from(bytes.subarray(0, 8), b => String.fromCharCode(b)).join("");
        if (header === "ASCII\0\0\0") bytes = bytes.subarray(8);
        else if (header === "UNICODE\0") {
          bytes = bytes.subarray(8);
          // Old Preview Plus stored UTF-16LE with a BOM here.
          if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
            return {comment: new TextDecoder("utf-16le").decode(bytes), exifOffset};
          if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
            return {comment: new TextDecoder("utf-16be").decode(bytes), exifOffset};
        }
        return {comment: new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, ""), exifOffset};
      }
      return {comment: null, exifOffset, description};
    }
    const first = ifd(read32(tiff + 4));
    // Preview Plus v0.6 stores workflow JSON in ImageDescription so Forge
    // can read a clean UserComment. Previous versions and JPG-Metadata used
    // JSON directly in UserComment; keep supporting both.
    if (first.description) {
      try {
        const data = JSON.parse(first.description);
        if (data && typeof data === "object" && (data.workflow || data.prompt))
          return first.description;
      } catch { /* not a graph */ }
    }
    if (first.comment !== null) return first.comment;
    if (first.exifOffset !== null) return ifd(first.exifOffset).comment;
    return null;
  }

  let pos = 2;
  while (pos + 4 <= end) {
    if (view.getUint8(pos++) !== 0xff) break;
    while (pos < end && view.getUint8(pos) === 0xff) pos++;
    if (pos >= end) break;
    const marker = view.getUint8(pos++);
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > end) break;
    const size = view.getUint16(pos);
    if (size < 2 || pos + size > end) break;
    const start = pos + 2, segmentEnd = pos + size;
    if (marker === 0xe1 && start + 6 <= segmentEnd &&
        view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0) {
      const comment = extractTiff(start + 6, segmentEnd);
      if (comment !== null) return comment;
    }
    pos = segmentEnd;
  }
  return null;
}

// JPEG APP1 is limited to ~64 KiB. PreviewPlus stores oversized complete
// graphs in lossless APP15 chunks instead, which the bundled importer restores.
function jpegChunkedGraph(buffer) {
  const view = new DataView(buffer);
  const end = view.byteLength;
  if (end < 4 || view.getUint16(0) !== 0xffd8) return null;
  const signature = new TextEncoder().encode("PreviewPlusGraph\0\x01");
  const chunks = new Map();
  let expected = null;
  let totalBytes = 0;
  let pos = 2;
  while (pos + 4 <= end) {
    if (view.getUint8(pos++) !== 0xff) break;
    while (pos < end && view.getUint8(pos) === 0xff) pos++;
    if (pos >= end) break;
    const marker = view.getUint8(pos++);
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > end) break;
    const size = view.getUint16(pos);
    if (size < 2 || pos + size > end) break;
    const start = pos + 2;
    const segmentEnd = pos + size;
    if (marker === 0xef && segmentEnd - start >= signature.length + 4) {
      const matches = signature.every((byte, offset) => view.getUint8(start + offset) === byte);
      if (matches) {
        const idx = view.getUint16(start + signature.length);
        const count = view.getUint16(start + signature.length + 2);
        if (!count || idx >= count || (expected !== null && count !== expected)) return null;
        expected = count;
        if (chunks.has(idx)) return null;
        const offset = start + signature.length + 4;
        const part = new Uint8Array(buffer, offset, segmentEnd - offset);
        totalBytes += part.byteLength;
        // Do not decode arbitrarily huge EXIF-style metadata from third-party files.
        if (totalBytes > 32 * 1024 * 1024) return null;
        chunks.set(idx, part);
      }
    }
    pos = segmentEnd;
  }
  if (expected === null || chunks.size !== expected) return null;
  const merged = new Uint8Array(totalBytes);
  let cursor = 0;
  for (let i = 0; i < expected; i++) {
    const chunk = chunks.get(i);
    if (!chunk) return null;
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return new TextDecoder("utf-8", {fatal: true}).decode(merged);
}

function jsonObject(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// Global (server-side) preferences. They do not belong to a node or workflow.
let sharedSettings = null;
let settingsPromise = null;
const activeControls = new Set();

function showSettings(settings) {
  sharedSettings = settings;
  for (const update of activeControls) update(settings);
}

async function requestJson(url, options) {
  const response = await api.fetchApi(url, options);
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshSettings() {
  if (!settingsPromise) {
    settingsPromise = requestJson("/preview_plus/settings")
      .then((result) => { showSettings(result); return result; })
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}

async function changeSettings(patch) {
  const result = await requestJson("/preview_plus/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  showSettings(result);
  return result;
}

function makeElement(tag, styles = {}, text = "") {
  const element = document.createElement(tag);
  Object.assign(element.style, styles);
  if (text) element.textContent = text;
  return element;
}

// Browse *server-side* folders: the browser's native directory picker cannot
// provide a usable filesystem path to the ComfyUI Python process.
async function chooseOutputFolder(initialPath, onSelect) {
  const background = makeElement("div", {
    position: "fixed", inset: "0", zIndex: "99999", display: "flex",
    alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.68)",
    fontFamily: "Arial, sans-serif", fontSize: "14px", color: "#eee",
  });
  const panel = makeElement("div", {
    width: "min(650px, 94vw)", maxHeight: "85vh", display: "flex", flexDirection: "column",
    gap: "10px", background: "#22252d", border: "1px solid #666", borderRadius: "10px",
    padding: "16px", boxShadow: "0 12px 35px #000a",
  });
  background.appendChild(panel);
  const header = makeElement("div", {display:"flex",alignItems:"center",justifyContent:"space-between"});
  header.appendChild(makeElement("strong", {}, "Preview Plus · Auto Save folder"));
  const closeButton = makeElement("button", {cursor:"pointer"}, "✕");
  header.appendChild(closeButton);
  panel.appendChild(header);
  panel.appendChild(makeElement("div", {fontSize:"12px",opacity:".8"},
    "Choose a folder on the computer running ComfyUI."));
  const pathRow = makeElement("div", {display:"flex",gap:"7px"});
  const pathInput = makeElement("input", {flex:"1",minWidth:"0",padding:"8px",color:"#eee",background:"#15181e",border:"1px solid #555",borderRadius:"5px"});
  pathInput.type = "text";
  pathInput.value = initialPath || "";
  pathInput.placeholder = "For example: D:\\Images\\ComfyUI";
  const goButton = makeElement("button", {cursor:"pointer",padding:"8px"}, "Go");
  pathRow.append(pathInput,goButton);
  panel.appendChild(pathRow);
  // Fixed, easily recognizable shortcuts. Paths come from the ComfyUI server
  // so redirected Windows folders (including OneDrive) resolve correctly.
  const quickBox = makeElement("div", {
    border:"1px solid #434851", borderRadius:"7px", padding:"9px",
    display:"flex", flexDirection:"column", gap:"7px", background:"#292d35",
  });
  quickBox.appendChild(makeElement("div", {
    fontSize:"12px",color:"#c7cdd8",fontWeight:"600",
  }, "Quick access"));
  const quickRow = makeElement("div", {
    display:"flex", flexWrap:"wrap", gap:"6px",
  });
  quickBox.appendChild(quickRow);
  panel.appendChild(quickBox);
  const navRow = makeElement("div", {display:"flex",gap:"6px",flexWrap:"wrap"});
  panel.appendChild(navRow);
  const folderList = makeElement("div", {minHeight:"90px",maxHeight:"43vh",overflowY:"auto",border:"1px solid #555",background:"#191c22",borderRadius:"6px",padding:"5px"});
  panel.appendChild(folderList);
  const error = makeElement("div", {minHeight:"16px",color:"#ffa4a4",fontSize:"12px"});
  panel.appendChild(error);
  const foot = makeElement("div", {display:"flex",gap:"8px",justifyContent:"flex-end",flexWrap:"wrap"});
  const defaultButton = makeElement("button", {cursor:"pointer",padding:"8px 12px"}, "Default output");
  const cancelButton = makeElement("button", {cursor:"pointer",padding:"8px 12px"}, "Cancel");
  const chooseButton = makeElement("button", {cursor:"pointer",padding:"8px 12px",fontWeight:"bold"}, "Select folder");
  foot.append(defaultButton,cancelButton,chooseButton);
  panel.appendChild(foot);
  document.body.appendChild(background);

  const close = () => {
    document.removeEventListener("keydown", keyHandler, true);
    background.remove();
  };
  const keyHandler = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  };
  document.addEventListener("keydown",keyHandler,true);
  background.addEventListener("mousedown", (event) => {if (event.target===background) close();});
  closeButton.onclick = cancelButton.onclick = close;
  function itemButton(text, click, wrap) {
    const b = makeElement("button", {
      cursor:"pointer",width: wrap ? "100%" : "auto",textAlign:"left",padding:"6px 8px",
      color:"#eee",background:"#30343e",border:"0",borderRadius:"4px",marginBottom: wrap ? "3px" : "0",
    },text);
    b.onclick = click;
    return b;
  }
  async function browse(path) {
    folderList.textContent="";
    folderList.appendChild(makeElement("div",{padding:"8px"},"Loading folders…"));
    error.textContent="";
    try {
      const result = await requestJson("/preview_plus/folders?path=" + encodeURIComponent(path || ""));
      pathInput.value = result.path;
      folderList.textContent="";
      quickRow.textContent="";
      const shortcutIcons = {
        "Desktop":"🖥️", "Downloads":"⬇️", "Documents":"📄",
        "Pictures":"🖼️", "Home":"🏠",
      };
      for (const entry of result.quick_access || []) {
        const icon = shortcutIcons[entry.label] || "📁";
        const button = itemButton(`${icon} ${entry.label}`, () => browse(entry.path), false);
        button.title = entry.path;
        button.style.background = entry.path === result.path ? "#3b5f85" : "#383e49";
        button.style.border = "1px solid #515a68";
        button.style.padding = "7px 9px";
        quickRow.appendChild(button);
      }
      navRow.textContent="";
      if (result.parent) {
        navRow.appendChild(itemButton("⬆ Up", () => browse(result.parent),false));
      }
      for (const root of result.roots || []) {
        navRow.appendChild(itemButton(root, () => browse(root),false));
      }
      for (const folder of result.folders || []) {
        // Do not build paths on the browser (Windows, POSIX and UNC differ).
        const sep = result.path.includes("\\") ? "\\" : "/";
        const full = result.path.endsWith("\\") || result.path.endsWith("/")
          ? result.path + folder : result.path + sep + folder;
        folderList.appendChild(itemButton("📁  " + folder, () => browse(full), true));
      }
      if (!result.folders?.length) {
        folderList.appendChild(makeElement("div",{padding:"8px",opacity:".75"},"No subfolders"));
      }
      if (result.truncated) error.textContent="List capped at 2,000 folders. Enter a path manually if needed.";
    } catch (err) {
      folderList.textContent="";
      error.textContent=err.message;
    }
  }
  goButton.onclick=()=>browse(pathInput.value);
  pathInput.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();browse(pathInput.value);}});
  chooseButton.onclick = async () => {
    chooseButton.disabled=true;
    error.textContent="";
    try {await onSelect(pathInput.value);close();}
    catch (err) {error.textContent=err.message;}
    finally {chooseButton.disabled=false;}
  };
  defaultButton.onclick = async () => {
    defaultButton.disabled=true;
    try {await onSelect("");close();}
    catch(err){error.textContent=err.message;}
    finally{defaultButton.disabled=false;}
  };
  await browse(initialPath);
}

async function saveManualImages(node) {
  const tokens = node.previewPlusTokens || [];
  if (!tokens.length) {
    window.alert("Preview Plus: Generate an image first.");
    return;
  }
  const fmt = node.widgets?.find(w => w.name === "format")?.value || "PNG";
  const full = Boolean(node.widgets?.find(w => w.name === "workflow_json")?.value);
  for (const token of tokens) {
    const url = `/preview_plus/download/${encodeURIComponent(token)}?format=${encodeURIComponent(fmt)}&workflow_json=${full}`;
    // A failed download used to be rendered by the browser as a .txt file.
    // Inspect HTTP status and Content-Type before offering a Save dialog.
    try {
      const response = await api.fetchApi(url);
      if (!response.ok) {
        const reason = await response.text();
        throw new Error(reason || `HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.startsWith("image/"))
        throw new Error("Server returned non-image content instead of a saved image");
      const file = await response.blob();
      const objectUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      const disposition = response.headers.get("content-disposition") || "";
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      link.href = objectUrl;
      link.download = filename || `preview_plus.${fmt.toLowerCase()}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (error) {
      window.alert("Preview Plus: Save failed\n" + error.message);
      console.error("[Preview Plus] Manual save failed:", error);
      break;
    }
  }
}

// Compact, theme-friendly row: Auto Save slider plus one contextual action.
// OFF -> manual download icon; ON -> destination-folder icon.
function previewPlusIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24", width: "18", height: "18", fill: "none",
    stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(key, value);
  const paths = name === "folder"
    ? ["M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"]
    : ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z",
       "M17 21v-8H7v8", "M7 3v5h8"];
  for (const data of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }
  return svg;
}

function addAutoSaveRow(node) {
  const row = makeElement("div", {
    width: "100%", height: "36px", boxSizing: "border-box", display: "flex",
    alignItems: "center", justifyContent: "space-between", gap: "10px",
    padding: "2px 10px", userSelect: "none", color: "var(--fg-color, #ddd)",
    fontFamily: "inherit", fontSize: "13px",
  });

  const group = makeElement("div", {display:"flex", alignItems:"center", gap:"10px", minWidth:"0"});
  const toggle = makeElement("button", {
    position:"relative", flex:"0 0 auto", width:"39px", height:"21px", padding:"0",
    border:"1px solid rgba(255,255,255,.15)", borderRadius:"999px", cursor:"pointer",
    background:"#515864", transition:"background .16s ease", outlineOffset:"2px",
    boxSizing:"border-box",
  });
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Auto Save");
  toggle.setAttribute("aria-checked", "false");
  const thumb = makeElement("span", {
    position:"absolute", left:"2px", top:"2px", width:"15px", height:"15px",
    borderRadius:"50%", background:"#fff", pointerEvents:"none",
    boxShadow:"0 1px 3px rgba(0,0,0,.35)", transition:"transform .16s ease",
  });
  toggle.appendChild(thumb);
  const textLabel = makeElement("span", {whiteSpace:"nowrap", cursor:"pointer",fontWeight:"500"}, "Auto Save");
  textLabel.title = "Toggle automatic image saving";
  group.append(toggle, textLabel);

  const action = makeElement("button", {
    width:"34px", height:"29px", flex:"0 0 34px", padding:"0", display:"flex",
    alignItems:"center", justifyContent:"center", cursor:"pointer",
    color:"var(--fg-color, #ddd)", background:"var(--comfy-input-bg, #31343c)",
    border:"1px solid rgba(255,255,255,.2)", borderRadius:"6px",
  });
  action.type = "button";
  const saveIcon = previewPlusIcon("save");
  const folderIcon = previewPlusIcon("folder");
  action.append(saveIcon, folderIcon);
  folderIcon.style.display = "none";  // Default OFF before the settings request completes.
  row.append(group, action);

  let busy = false;
  function update(settings) {
    const enabled = Boolean(settings.auto_save);
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.title = enabled ? "Disable Auto Save" : "Enable Auto Save";
    toggle.style.background = enabled ? "var(--p-button-primary-background, #3478c5)" : "#515864";
    thumb.style.transform = enabled ? "translateX(18px)" : "translateX(0)";
    saveIcon.style.display = enabled ? "none" : "block";
    folderIcon.style.display = enabled ? "block" : "none";
    action.title = enabled
      ? `Choose Auto Save folder\nCurrent: ${settings.effective_directory || "ComfyUI/output"}`
      : "Save / Download images with metadata";
    action.setAttribute("aria-label", enabled ? "Choose Auto Save folder" : "Save / Download images");
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true,true);
  }

  activeControls.add(update);
  const previousRemoved = node.onRemoved;
  node.onRemoved = function () {
    activeControls.delete(update);
    return previousRemoved?.apply(this, arguments);
  };

  async function switchAutoSave() {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try {
      const current = sharedSettings || await refreshSettings();
      await changeSettings({auto_save: !Boolean(current.auto_save)});
    } catch (error) {
      window.alert("Preview Plus: " + error.message);
      if (sharedSettings) update(sharedSettings);
    } finally {
      busy = false;
      toggle.disabled = false;
    }
  }
  toggle.onclick = switchAutoSave;
  textLabel.onclick = switchAutoSave;
  action.onclick = () => {
    if (sharedSettings?.auto_save) {
      chooseOutputFolder(sharedSettings.effective_directory || "", async path => {
        await changeSettings({output_directory: path});
      }).catch(error => window.alert("Preview Plus: " + error.message));
    } else {
      saveManualImages(node);
    }
  };

  // Presentation-only, globally persisted by the Python server, not the graph.
  node.addDOMWidget("preview_plus_global_autosave", "custom", row, {
    serialize:false, hideOnZoom:false,
    getHeight:() => 36, getMinHeight:() => 36, getMaxHeight:() => 36,
    getValue:() => "", setValue:() => {},
  });
  if (sharedSettings) update(sharedSettings);
  refreshSettings().catch(error => console.warn("[Preview Plus] Settings:",error));
}

app.registerExtension({
  name: "PreviewPlus.ManualAndAutoSave",
  async setup() {
    const oldHandleFile = app.handleFile;
    app.handleFile = async function (file) {
      if (file && (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name || ""))) {
        try {
          const buffer = await file.arrayBuffer();
          const comment = jpegChunkedGraph(buffer) || jpegUserComment(buffer);
          if (comment) {
            const data = jsonObject(comment);
            if (data) {
              const workflow = jsonObject(data.workflow);
              if (workflow) { await this.loadGraphData(workflow); return; }
              const prompt = jsonObject(data.prompt);
              if (prompt) { await this.loadApiJson(prompt); return; }
            }
          }
        } catch (error) {
          console.warn("[Preview Plus] Could not restore JPG workflow:", error);
        }
      }
      return oldHandleFile.apply(this, arguments);
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PreviewPlus") return;
    const oldCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = oldCreated?.apply(this, arguments);
      this.previewPlusTokens = [];
      addAutoSaveRow(this);
      return result;
    };
    const oldExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      oldExecuted?.apply(this,arguments);
      const info = message?.preview_plus?.[0];
      if (!info) return;
      this.previewPlusTokens = info.tokens || [];
      if (info.errors?.length) {
        window.alert("Preview Plus: Auto Save error:\n" + info.errors.join("\n"));
      }
    };
  },
});
