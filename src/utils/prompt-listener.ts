import { request as makeHttpRequest } from "node:http";
import inquirer from "inquirer";
import { log } from "./logger.js";
import { CONTROL_TOKEN_HEADER, readControlToken } from "../proxy/control-token.js";

export interface PromptListener {
  stop: () => void;
}

export function startPromptListener(proxyPort: number): PromptListener {
  let active = true;

  async function loop() {
    while (active) {
      try {
        // Re-read each poll: the daemon writes a fresh token when it restarts
        const token = await readControlToken();
        const prompts = token ? await getPendingPrompts(proxyPort, token) : [];
        if (prompts && prompts.length > 0) {
          for (const prompt of prompts) {
            if (!active) break;

            console.log();
            log.warn(`Sandbox is requesting access to an unauthorised host`);
            console.log(`  Method : ${prompt.method}`);
            console.log(`  Host   : ${prompt.host}`);
            console.log(`  URL    : ${prompt.url}`);
            console.log();

            const promptPromise = inquirer.prompt<{ decision: "allow_once" | "allow_always" | "deny" }>([
              {
                type: "list",
                name: "decision",
                message: "How should this request be handled?",
                choices: [
                  { name: "Allow once   (this request only)", value: "allow_once" },
                  { name: "Allow always (add to active policy)", value: "allow_always" },
                  { name: "Deny         (block this request)", value: "deny" },
                ],
                default: "deny",
              },
            ]);

            const { decision } = await promptPromise;
            await submitPromptDecision(proxyPort, token!, prompt.id, decision);
          }
        }
      } catch (err) {
        // ignore polling errors (e.g. proxy starting up)
      }
      // Poll every 500ms
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  loop();

  return {
    stop: () => {
      active = false;
    },
  };
}

async function getPendingPrompts(port: number, token: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = makeHttpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/_silo/prompts",
        method: "GET",
        headers: { [CONTROL_TOKEN_HEADER]: token },
        timeout: 2000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function submitPromptDecision(
  port: number,
  token: string,
  id: string,
  decision: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ decision });
    const req = makeHttpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: `/_silo/prompts/${id}/decision`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [CONTROL_TOKEN_HEADER]: token,
        },
        timeout: 2000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
