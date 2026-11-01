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
| `src/main/scan/worker.ts` | Runs scans on a worker thread so the UI stays responsive |
| `src/main/scan/categorize.ts` | Beat / Demo / Music / Drum + drum sub-type rules |
| `src/main/scan/parseName.ts` | BPM and key from file and folder names |
| `src/renderer/src` | React UI (sidebar, virtualized table, inspector, player bar) |
| `tests/` | Vitest tests |

## Milestones

1. **Scanning + list view** ✅
2. **Preview player, waveform, keyboard navigation, drag to DAW** ✅
3. Categories, sub-types, tags, rating, favorites, notes (editing)
4. Search and filters
5. Collections
6. Duplicates

## Keys

| Key | Action |
|---|---|
| Click | Select and preview |
| Space | Play / stop |
| ↑ / ↓ | Previous / next file, auto-preview |
| Esc | Stop |

Drag any row into Ableton (or Finder/Explorer) to use the original file; nothing is copied.
SYNC time-stretches files that have a BPM to the project tempo, keeping pitch.

## Building for macOS

The app has no native modules, so the same code runs on macOS. Packaging a `.dmg`
(electron-builder, added in a later milestone) has to run on a Mac or a macOS CI runner.
