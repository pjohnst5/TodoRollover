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
 * Merge new todo lines into existing content under the given heading.
 * Creates the heading if it doesn't exist. Deduplicates by exact match.
 */
function mergeTodosIntoContent(
  content: string,
  heading: string,
  newTodos: string[]
): string {
  if (newTodos.length === 0) return content;

  const lines = content.split("\n");

  // Collect existing todos under the heading so we can deduplicate
  const existingTodos = new Set<string>();
  let headingIndex = -1;
  let sectionEndIndex = -1;
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      if (inSection) {
        sectionEndIndex = i;
        break;
      }
      if (lines[i].trim().toLowerCase() === heading.trim().toLowerCase()) {
        headingIndex = i;
        inSection = true;
      }
      continue;
    }

    if (inSection) {
      const trimmed = lines[i].trim();
      if (trimmed.length > 0) {
        existingTodos.add(trimmed);
      }
    }
  }

  // Deduplicate: only keep genuinely new entries
  const todosToAdd = newTodos.filter(
    (t) => !existingTodos.has(t.trim())
  );

  if (todosToAdd.length === 0) return content;

  // If heading doesn't exist, append it at the end of the file
  if (headingIndex === -1) {
    const suffix =
      (content.endsWith("\n") ? "" : "\n") +
      "\n" +
      heading +
      "\n" +
      todosToAdd.join("\n") +
      "\n";
    return content + suffix;
  }

  // Insert right before the next heading (or at end of file)
  const insertIndex = sectionEndIndex === -1 ? lines.length : sectionEndIndex;

  // Make sure there's a blank line before we append, for readability
  const block = todosToAdd.join("\n");
  lines.splice(insertIndex, 0, block);

  return lines.join("\n");
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

    if (unfinished.length === 0) {
      if (manual) {
        new Notice("No unchecked todos found in the previous daily note.");
      }
      this.processedToday = true;
      this.lastProcessedDate = dateKey;
      return;
    }

    // 4. Read today's note and merge
    const todayContent = await this.app.vault.read(todayFile as TFile);
    const merged = mergeTodosIntoContent(todayContent, TODO_HEADING, unfinished);

    if (merged !== todayContent) {
      await this.app.vault.modify(todayFile as TFile, merged);
      new Notice(
        `Rolled over ${unfinished.length} todo(s) from ${prevFile.basename}.`
      );
    } else if (manual) {
      new Notice("All todos already present — nothing to roll over.");
    }

    this.processedToday = true;
    this.lastProcessedDate = dateKey;
  }
}
