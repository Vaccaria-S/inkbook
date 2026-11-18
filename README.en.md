# Inkbook

[简体中文](README.md) | English

An **A4 handwriting notebook inside Obsidian**: write and draw with pressure-sensitive
strokes, and your notes are saved directly inside the vault — so they sync with
Obsidian Sync / any cloud drive. The handwriting engine is built from scratch
(Canvas + PointerEvent), with a focus on **how the pen feels**.

> License: [MIT](LICENSE). Free to use, modify and distribute, including
> commercially, as long as the copyright and license notice are kept.

---

## Features

**Paper & pages**
- Continuous A4 portrait scrolling — keep writing downwards when a page fills up
- 6 paper templates: blank / ruled / grid / dotted / Cornell / weekly plan
- 3 paper tints: white / cream / light gray
- Page thumbnails, add page, duplicate page, delete page, jump to page

**Pens**
- Fountain pen (pressure-sensitive stroke), ballpoint, highlighter (multiply blend, still shows text underneath)
- Whole-stroke eraser / partial eraser (partial erase splits a stroke)
- Shapes: rectangle / ellipse / line / arrow (hold Shift to snap angles and squares)
- Lasso: circle to select, drag to move, Delete to remove
- One-stroke shapes: hand-draw a rectangle / ellipse / line / arrow and it snaps to a clean shape on pen-lift (toggle in the pen popup, off by default)
- Laser pointer: leaves only a fading red indicator trail — nothing written, nothing exported (off by default)
- Hide-ink layer: hide a layer's handwriting entirely (built into layers); export is unaffected

**Organization**
- Multiple layers: hide, rename, delete
- Undo / redo (works across pages)
- Auto-save

**Export**
- Whole notebook to PDF
- Current page to PNG (2× resolution)

---

## Installation

### Option 1: Manual install
1. Download `main.js`, `manifest.json` and `styles.css` from the repo root;
2. Create a folder in your vault: `<your-vault>/.obsidian/plugins/inkbook/`;
3. Put those three files in it;
4. Back in Obsidian → Settings → Community plugins → turn off Safe mode → reload installed plugins → enable **Inkbook**.

### Option 2: BRAT (beta plugin)
Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add
this repository's URL to install and update automatically.

### Option 3: Obsidian community plugin directory
Listing in the community directory requires a separate review submission; once
approved it can be installed directly from **Browse**.

---

## Usage

- Create a new `.inkbook` file in the vault (command palette: **Inkbook: New notebook**) and start writing.
- The toolbar switches pen / eraser / shape / lasso / text; the sidebar manages layers, thumbnails and pages.
- All generated files (text index, imported images, etc.) live under `墨本文件/` at the vault root, grouped per notebook.

---

## Shortcuts (customizable)

Defaults below; every one can be changed in **Settings → Inkbook → Hotkeys**. `Ctrl` means `⌘` on macOS.

| Key | Action |
| --- | --- |
| `P` / `B` / `H` | Fountain pen / ballpoint / highlighter |
| `E` / `V` / `R` / `T` | Eraser / select·move / shape / text |
| `I` | Toggle "stylus only" (fingers scroll only, palms don't write) |
| `Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+Y` | Undo / redo |
| `Ctrl+S` | Save now |
| `Ctrl+F` | Find text in the current note |
| `0` | Fit page to window |
| `+` / `=`, `-` | Zoom in / out |
| `Delete` / `Backspace` | Delete selected text |
| `Esc` | Clear selection / collapse sidebar |

---

## File format

A `.inkbook` file is a plain JSON file in the vault and syncs with Obsidian Sync / any
cloud drive. Strokes store only **sample points + pressure**; thickness and taper are
computed at render time, so files stay small and switching nib styles doesn't require
rewriting data.

---

## Development / build

For maintainers who want to build it themselves:

```bash
npm install
npm run typecheck     # type check
npm run build         # outputs dist/inkbook/{main.js, manifest.json, styles.css}
```

- `src/` is the source; `assets/` holds the font subsets inlined at build time.
- `main.js` and `styles.css` are what Obsidian actually loads; when releasing a new
  version, update the root `main.js`, `manifest.json`, `styles.css`, and bump the
  version in `versions.json` and `manifest.json`.

---

## Feedback

Feel free to open an issue in [Issues](../../issues).

---

## License

[MIT](LICENSE). Free to use, modify and distribute, including commercially,
as long as the copyright and license notice are kept.
Full terms in [LICENSE](LICENSE).
