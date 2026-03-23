import {
  Plugin,
  TFile,
  Notice,
  moment,
} from "obsidian";

/**
 * Resolves the daily-notes core plugin settings.
 * Falls back to sensible defaults when the core plugin is not enabled.
 */
function getDailyNoteSettings(plugin: Plugin): {
  format: string;
  folder: string;
  template: string;
} {
  // Obsidian stores core-plugin config under (app as any).internalPlugins
  const internalPlugins = (plugin.app as any).internalPlugins;
  let format = "YYYY-MM-DD";
  let folder = "";
  let template = "";

  if (internalPlugins) {
    const dailyNotes = internalPlugins.getPluginById?.("daily-notes");
    if (dailyNotes?.instance?.options) {
      const opts = dailyNotes.instance.options;
      format = opts.format || format;
      folder = opts.folder || folder;
      template = opts.template || template;
    }
  }

  return { format, folder, template };
}

/**
 * Given a moment date and the daily-note format string, build the full
 * vault-relative path (without .md extension) for that day's note.
 */
function dailyNotePath(date: moment.Moment, format: string, folder: string): string {
  const formatted = date.format(format);
  return folder ? `${folder}/${formatted}` : formatted;
}

/**
 * Extract unchecked todo lines that live under a specific heading.
 * Supports nested / indented items belonging to the same section.
 */
function extractUnfinishedTodos(
  content: string,
  heading: string
): string[] {
  const lines = content.split("\n");
  let inSection = false;
  const todos: string[] = [];

  for (const line of lines) {
    // Detect heading boundaries
    if (/^#{1,6}\s/.test(line)) {
      inSection = line.trim().toLowerCase() === heading.trim().toLowerCase();
      continue;
    }

    if (!inSection) continue;

    // Match unchecked checkbox lines (top-level or indented)
    if (/^(\s*)-\s\[ \]\s/.test(line)) {
      todos.push(line);
    }
  }

  return todos;
}

/**
 * Strip the checkbox marker from a todo line to get just the text content.
 * e.g. "- [ ] Buy milk" and "- [x] Buy milk" both become "Buy milk"
 * Also handles indented items like "  - [ ] Sub-task"
 */
function todoText(line: string): string {
  return line.replace(/^\s*-\s\[.\]\s*/, "").trim();
}

/**
 * Merge new todo lines into existing content under the given heading.
 * Creates the heading if it doesn't exist.
 * Deduplicates by text content (ignoring checkbox state).
 */
function mergeTodosIntoContent(
  content: string,
  heading: string,
  newTodos: string[]
): { result: string; added: number } {
  if (newTodos.length === 0) return { result: content, added: 0 };

  const lines = content.split("\n");

  // Collect existing todo *text* under the heading so we can deduplicate
  // regardless of whether items are checked or unchecked.
  const existingTexts = new Set<string>();
  let headingIndex = -1;
  let lastListItemIndex = -1; // track the last list-item line in the section
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      if (inSection) break; // hit the next heading — section is over
      if (lines[i].trim().toLowerCase() === heading.trim().toLowerCase()) {
        headingIndex = i;
        inSection = true;
      }
      continue;
    }

    if (!inSection) continue;

    const trimmed = lines[i].trim();

    // Track list items (checked or unchecked) and indented continuations
    if (/^-\s\[.\]\s/.test(trimmed)) {
      existingTexts.add(todoText(trimmed));
      lastListItemIndex = i;
    } else if (/^\s+-/.test(lines[i]) && lastListItemIndex !== -1) {
      // indented sub-item of the previous list entry
      lastListItemIndex = i;
    }
  }

  // Deduplicate: only keep entries whose text doesn't already appear
  const todosToAdd = newTodos.filter(
    (t) => !existingTexts.has(todoText(t))
  );

  if (todosToAdd.length === 0) return { result: content, added: 0 };

  // If heading doesn't exist, append it at the end of the file
  if (headingIndex === -1) {
    const suffix =
      (content.endsWith("\n") ? "" : "\n") +
      "\n" +
      heading +
      "\n" +
      todosToAdd.join("\n") +
      "\n";
    return { result: content + suffix, added: todosToAdd.length };
  }

  // Insert right after the last list item in the section
  // (or right after the heading if the section is empty)
  const insertAfter =
    lastListItemIndex !== -1 ? lastListItemIndex : headingIndex;

  const block = todosToAdd.join("\n");
  lines.splice(insertAfter + 1, 0, block);

  return { result: lines.join("\n"), added: todosToAdd.length };
}

/**
 * Walk backwards from today to find the most recent daily note that exists.
 * Searches up to `maxDays` in the past (default 30).
 */
async function findPreviousDailyNote(
  plugin: Plugin,
  today: moment.Moment,
  format: string,
  folder: string,
  maxDays = 30
): Promise<TFile | null> {
  for (let i = 1; i <= maxDays; i++) {
    const prev = today.clone().subtract(i, "days");
    const path = dailyNotePath(prev, format, folder) + ".md";
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return file;
    }
  }
  return null;
}

const TODO_HEADING = "## Todo";

export default class TodoRolloverPlugin extends Plugin {
  private processedToday = false;
  private lastProcessedDate = "";

  async onload() {
    // Register command palette action
    this.addCommand({
      id: "rollover-todos-now",
      name: "Rollover todos from previous daily note",
      callback: () => this.rolloverTodos(true),
    });

    // Trigger when a file is opened
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) {
          this.onFileOpen(file);
        }
      })
    );
  }

  /**
   * Called every time a file is opened. Checks whether it's today's daily
   * note and, if so, performs the rollover (once per day unless forced).
   */
  private async onFileOpen(file: TFile) {
    const { format, folder } = getDailyNoteSettings(this);
    const today = moment();
    const todayPath = dailyNotePath(today, format, folder) + ".md";

    if (file.path !== todayPath) return;

    // Only auto-rollover once per calendar day
    const dateKey = today.format("YYYY-MM-DD");
    if (this.processedToday && this.lastProcessedDate === dateKey) return;

    await this.rolloverTodos(false);
  }

  /**
   * Core rollover logic.
   * @param manual – true when triggered from command palette (shows notices even if nothing to do)
   */
  private async rolloverTodos(manual: boolean) {
    const { format, folder } = getDailyNoteSettings(this);
    const today = moment();
    const dateKey = today.format("YYYY-MM-DD");

    // 1. Get today's daily note
    const todayPath = dailyNotePath(today, format, folder) + ".md";
    let todayFile = this.app.vault.getAbstractFileByPath(todayPath);

    if (!(todayFile instanceof TFile)) {
      if (manual) {
        new Notice("Today's daily note does not exist yet.");
      }
      return;
    }

    // 2. Find the previous daily note
    const prevFile = await findPreviousDailyNote(
      this,
      today,
      format,
      folder
    );

    if (!prevFile) {
      if (manual) {
        new Notice("No previous daily note found (searched last 30 days).");
      }
      return;
    }

    // 3. Read previous note and extract unchecked todos
    const prevContent = await this.app.vault.read(prevFile);
    const unfinished = extractUnfinishedTodos(prevContent, TODO_HEADING);

    // 4. Read today's note and merge
    const todayContent = await this.app.vault.read(todayFile as TFile);
    const { result: merged, added } = mergeTodosIntoContent(todayContent, TODO_HEADING, unfinished);

    if (merged !== todayContent) {
      await this.app.vault.modify(todayFile as TFile, merged);
    }

    new Notice(
      `Rolled over ${added} todo(s) from ${prevFile.basename}.`
    );

    this.processedToday = true;
    this.lastProcessedDate = dateKey;
  }
}
