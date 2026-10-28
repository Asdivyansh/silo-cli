/**
 * Built-in Integration Templates
 *
 * Pre-configured templates for popular productivity APIs. When the user runs
 * `silo integrations add slack`, the template pre-fills everything except the
 * API token — eliminating guesswork about base URLs, auth schemes, and header names.
 *
 * Adding a new template:
 *   1. Add an entry to BUILTIN_TEMPLATES below
 *   2. That's it — the CLI and proxy will pick it up automatically
 */

// ---------------------------------------------------------------------------
// Template type
// ---------------------------------------------------------------------------

export interface IntegrationTemplate {
  /** Machine name (must match the key in BUILTIN_TEMPLATES) */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Short description shown in `silo integrations add --help` */
  description: string;
  /** The real API base URL that the proxy forwards to */
  baseUrl: string;
  /** How credentials are attached to outbound requests */
  authType: "bearer" | "header" | "query";
  /** For authType="header": the header name to inject */
  authHeader?: string;
  /** For authType="query": the query parameter name to inject */
  authQueryParam?: string;
  /** Extra headers to inject on every forwarded request (e.g. API version) */
  extraHeaders?: Record<string, string>;
  /** Help text shown when prompting for the token */
  tokenHint: string;
  /** Link to the service's API key / token documentation */
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: Record<string, IntegrationTemplate> = {
  slack: {
    name: "slack",
    displayName: "Slack",
    description: "Send messages, manage channels, and interact with the Slack API",
    baseUrl: "https://slack.com/api",
    authType: "bearer",
    tokenHint: "Bot User OAuth Token (starts with xoxb-…)",
    docsUrl: "https://api.slack.com/authentication/token-types",
  },

  github: {
    name: "github",
    displayName: "GitHub",
    description: "Manage repos, issues, pull requests, and actions via the GitHub REST API",
    baseUrl: "https://api.github.com",
    authType: "bearer",
    extraHeaders: {
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    tokenHint: "Personal Access Token (starts with ghp_… or github_pat_…)",
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  },

  hubspot: {
    name: "hubspot",
    displayName: "HubSpot",
    description: "Manage contacts, deals, tickets, and CRM objects via the HubSpot API",
    baseUrl: "https://api.hubapi.com",
    authType: "bearer",
    tokenHint: "Private App Access Token (starts with pat-…)",
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
  },

  linear: {
    name: "linear",
    displayName: "Linear",
    description: "Create and manage issues, projects, and teams via the Linear API",
    baseUrl: "https://api.linear.app",
    authType: "bearer",
    tokenHint: "API Key (starts with lin_api_…)",
    docsUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
  },

  notion: {
    name: "notion",
    displayName: "Notion",
    description: "Read and write pages, databases, and blocks via the Notion API",
    baseUrl: "https://api.notion.com",
    authType: "bearer",
    extraHeaders: {
      "notion-version": "2022-06-28",
    },
    tokenHint: "Internal Integration Token (starts with secret_…)",
    docsUrl: "https://developers.notion.com/docs/authorization",
  },
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get a template by name (case-insensitive). */
export function getTemplate(name: string): IntegrationTemplate | undefined {
  return BUILTIN_TEMPLATES[name.toLowerCase()];
}

/** Return all built-in templates as an array. */
export function listTemplates(): IntegrationTemplate[] {
  return Object.values(BUILTIN_TEMPLATES);
}

/** Return all template names. */
export function templateNames(): string[] {
  return Object.keys(BUILTIN_TEMPLATES);
}
