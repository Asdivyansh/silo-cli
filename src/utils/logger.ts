import chalk from "chalk";
import boxen from "boxen";

const PREFIX = {
  info: chalk.cyan("ℹ"),
  success: chalk.green("✔"),
  warn: chalk.yellow("⚠"),
  error: chalk.red("✖"),
  debug: chalk.gray("◆"),
} as const;

/**
 * In file mode (SILO_LOG_TIMESTAMPS=1, set when the proxy daemon's output
 * is redirected to ~/.silo/logs/proxy.log) every line gets an ISO timestamp
 * and a greppable level tag instead of the interactive icon.
 */
function prefix(level: keyof typeof PREFIX): string {
  if (process.env["SILO_LOG_TIMESTAMPS"]) {
    return `${new Date().toISOString()} [${level.toUpperCase()}]`;
  }
  return PREFIX[level];
}

export const log = {
  info: (msg: string) => console.log(`${prefix("info")}  ${msg}`),
  success: (msg: string) => console.log(`${prefix("success")}  ${chalk.green(msg)}`),
  warn: (msg: string) => console.warn(`${prefix("warn")}  ${chalk.yellow(msg)}`),
  error: (msg: string) => console.error(`${prefix("error")}  ${chalk.red(msg)}`),
  debug: (msg: string) => {
    if (process.env["SILO_DEBUG"]) {
      console.log(`${prefix("debug")}  ${chalk.gray(msg)}`);
    }
  },
  blank: () => console.log(),
};

/** Print a branded banner used at startup. */
export function printBanner(): void {
  const banner = boxen(
    chalk.bold.cyan("SILO") +
      "  " +
      chalk.dim("v0.2.0") +
      "\n" +
      chalk.dim("Secure AI Agent Sandbox Orchestrator"),
    {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "cyan",
    },
  );
  console.log(banner);
  log.blank();
}

/** Print a section header. */
export function section(title: string): void {
  console.log(chalk.bold.underline(title));
}

/** Dim key=value pair for status tables. */
export function kv(key: string, value: string): string {
  return `${chalk.dim(key.padEnd(18))} ${value}`;
}
