# Todo Rollover — Obsidian Plugin

Automatically rolls over unchecked todos (`- [ ]`) from your **previous daily note** into **today's daily note**, under the `## Todo` heading.

## Features

- **Auto-trigger** — runs whenever you open today's daily note (once per day).
- **Command palette** — search for **"Rollover todos from previous daily note"** to trigger manually.
- **Duplicate-safe** — identical entries are never added twice.
- **Heading auto-create** — if `## Todo` doesn't exist in today's note, it's appended automatically.
- **Mobile-compatible** — uses only the Obsidian Vault API (no Node.js `fs`/`path`).

## How it works

1. Reads the **Daily Notes** core plugin settings from your vault (date format, folder).
2. Searches backwards (up to 30 days) for the most recent previous daily note.
3. Extracts every unchecked `- [ ]` line under the `## Todo` heading.
4. Merges them into today's note, skipping any that already exist.

## Installation

### Manual install (recommended for development)

1. Build the plugin:

   ```bash
   npm install
   npm run build
   ```

2. Copy these files into your vault's plugin folder:

   ```
   <vault>/.obsidian/plugins/todo-rollover/
   ├── main.js
   └── manifest.json
   ```

3. In Obsidian → Settings → Community Plugins, enable **Todo Rollover**.

### Quick copy script (macOS)

```bash
VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian"
DEST="$VAULT/.obsidian/plugins/todo-rollover"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
```

Then restart Obsidian (or reload plugins) and enable the plugin.

## Configuration

The plugin inherits your vault's **Daily Notes** core-plugin settings:

| Setting        | Where to configure                          |
| -------------- | ------------------------------------------- |
| Date format    | Settings → Daily Notes → Date format        |
| Notes folder   | Settings → Daily Notes → New file location  |

No additional plugin settings are needed.

## Requirements

- Obsidian ≥ 0.15.0
- **Daily Notes** core plugin enabled
