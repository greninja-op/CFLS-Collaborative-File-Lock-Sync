import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const required = ["CFLS_REPO_ID", "CFLS_TEAM_ID", "CFLS_BRANCH"];
for (const key of required) {
  if (typeof process.env[key] !== "string" || process.env[key].trim() === "") {
    throw new Error(`${key} is required to create the CFLS manual session.`);
  }
}

const baseRevision = process.env.CFLS_BASE_REVISION;
const session = {
  repoId: process.env.CFLS_REPO_ID,
  teamId: process.env.CFLS_TEAM_ID,
  branch: process.env.CFLS_BRANCH,
  baseRevision:
    typeof baseRevision === "string" && baseRevision.trim() !== ""
      ? baseRevision
      : null,
};

const path = "/app/.coordination/session.json";
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
