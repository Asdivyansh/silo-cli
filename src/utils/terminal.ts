import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Auto-spawns a new native terminal window running `silo logs --follow`
 * to show real-time proxy activity during a session.
 */
export async function spawnLogsTerminal(): Promise<void> {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  if (!isMac && !isWin) {
    // Linux CLI environments don't have a standard window manager or terminal command
    return;
  }

  // We run silo logs --follow. Since the user might be running via npm link / global package
  // or local development, "silo logs --follow" is the cleanest standard command.
  const command = "silo logs --follow";

  if (isMac) {
    const script = `tell application "Terminal" to do script "${command}"`;
    try {
      await execAsync(`osascript -e '${script}'`);
    } catch {
      // Ignore failures silently (non-fatal UX helper)
    }
  } else if (isWin) {
    try {
      // cmd /k keeps the terminal open so they can see logs
      await execAsync(`start cmd /k "${command}"`);
    } catch {
      // Ignore failures silently
    }
  }
}
