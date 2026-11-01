# Sample Manager

A local, offline library manager for beats, demos, music samples and drum samples.
Electron + React + TypeScript, with the index kept in SQLite (Node's built-in `node:sqlite`).
Your audio files are only ever read: the app never moves, renames, deletes or uploads them.

## Run

```bash
npm install
npm run dev        # app with hot reload
npm test           # scanner, categorizer and BPM/key parser tests
npm run typecheck
npm run build && npm start   # production build
```

The library index lives in your user data folder (`%APPDATA%\sample-manager\library.db` on Windows,
`~/Library/Application Support/sample-manager/library.db` on macOS).
Set `SAMPLE_MANAGER_DATA_DIR` to use a different (e.g. throwaway) library.

## Layout

| Path | What |
|---|---|
| `src/main/index.ts` | Electron main process, IPC handlers |
| `src/main/db.ts` | SQLite schema, migrations and queries |
| `src/main/scan/scanner.ts` | Folder walk, metadata, rescan / missing / moved-file relink |
| `src/main/playback.ts` | `sm-audio://` streaming protocol (byte ranges) and native drag-out |
| `src/main/audio.ts` | Range parsing, AIFF → WAV preview conversion |
| `src/shared/analysis.ts` | Tempo and key detection (onset envelope, comb autocorrelation, chroma + key profiles) |
| `src/main/analysis.ts`, `src/renderer/src/analyzer.ts` | Analysis queue and the hidden page that decodes audio for it |
| `src/main/dupes/` | Duplicate finding: audio location per format, staged hashing, worker |
| `src/main/scan/worker.ts` | Runs scans on a worker thread so the UI stays responsive |
| `src/main/scan/categorize.ts` | Beat / Demo / Music / Drum + drum sub-type rules |
| `src/main/scan/parseName.ts` | BPM and key from file and folder names |
| `src/renderer/src` | React UI (sidebar, virtualized table, inspector, player bar) |
| `tests/` | Vitest tests |

## Milestones

1. **Scanning + list view** ✅
2. **Preview player, waveform, keyboard navigation, drag to DAW** ✅
3. **Editing: category, drum type, BPM, key, tags, rating, favorites, notes; multi-select** ✅
4. **Search and filters: BPM range (with half/double time), key (with compatible keys), rating, length, format** ✅
5. **Collections: lists of links to your files, nothing copied** ✅
6. **Duplicates: same audio found across names, folders and tags; extra copies go to the Recycle Bin/Trash only after you confirm** ✅

## Keys

| Key | Action |
|---|---|
| Click | Select and preview |
| Ctrl-click (⌘-click on Mac) | Add / remove a file from the selection |
| Shift-click, Shift+↑/↓ | Select a range |
| Ctrl+A (⌘A) | Select everything in the current list |
| Space | Play / stop |
| ↑ / ↓ | Previous / next file, auto-preview |
| 1–5, 0 | Rate the selection, clear rating |
| F | Favorite / unfavorite the selection |
| Ctrl+F (⌘F) or / | Search |
| ↓ or Enter in the search box | Jump to the first result and play it |
| Esc | Stop (in the search box: clear it) |
| Right-click | Add to collection, remove from collection, show in folder, copy path |

Drag any row into Ableton (or Finder/Explorer) to use the original file; nothing is copied.
Dragging a selected row drags the whole selection.

Search looks in file names, folder names, tags and notes, and matches any part of a word
("punch" finds "KickPunchy"). Every word has to match; `"quotes"` keep words together and
`-word` leaves files out. Filters stack on top of the sidebar view and the search.

Collections group files for a project or kit without copying them. Add files by dragging them
onto a collection in the sidebar (or onto the Collections heading to make a new one), by
right-clicking them, or from the inspector. Deleting a collection only deletes the list.

Duplicates are found by comparing the audio itself, ignoring names, folders and tags (WAV, AIFF,
FLAC, MP3 and M4A are looked inside; other formats are compared whole). It runs in the background
after every scan and only reads what it must. The Duplicates view can move extra copies to the
Recycle Bin/Trash, but only after a confirmation listing the files, never the last copy of a
sound, and the copy that stays inherits the others' tags, ratings, notes and collections.

BPM and key are also detected by listening to the audio, in the background after each scan
(newest files first). Detected values only fill in what file names, folders and tags don't say,
and only when the detector is confident; they never replace a value you set. The inspector shows
what was detected next to the value in use, with a button to use it. Drum one-shots are skipped;
808s and other short melodic sounds get their note. Right-click › Detect BPM and Key Again
re-runs it for chosen files.

Edits (category, type, BPM, key, tags, rating, favorites, notes) only change the library
index, never the audio files. Category, type, BPM and key you set are marked *manual* and a
rescan never overwrites them, even if the file changes on disk.
SYNC time-stretches files that have a BPM to the project tempo, keeping pitch.

## Building the app

```bash
npm run dist:mac   # on a Mac: dist/Sample-Manager-<version>-arm64.dmg and -x64.dmg
npm run dist:win   # on Windows: dist/Sample-Manager-Setup-<version>.exe
npm run pack       # unpacked app in dist/ for a quick check, any platform
```

Without a Mac, use GitHub Actions: push this repo to GitHub, open **Actions › Build macOS app ›
Run workflow**, and download the `.dmg` files from the finished run's **Artifacts**. Pushing a
tag like `v0.2.0` also publishes them as a GitHub release. See `.github/workflows/build-mac.yml`.

**Opening it on a Mac.** Without an Apple Developer ID ($99/year) the app is signed ad hoc, so
macOS warns the first time: "Apple could not verify Sample Manager is free of malware". Open it
once via **System Settings › Privacy & Security › Open Anyway** (or right-click the app › Open
on older macOS). After that it opens normally. With a Developer ID, add the secrets listed at
the top of the workflow and it will be signed and notarized, with no warning.

Pick the `arm64` .dmg for Apple Silicon (M1 and later) and `x64` for Intel Macs.

The library is stored in the same place whether you run from source or the installed app
(`sample-manager` in the user data folder above), so switching keeps your tags, ratings and
collections. The app icon is drawn by `scripts/make-icon.mjs` (`npm run icon`).
