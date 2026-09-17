/** Bootstrap only the client's loopback Convex gateway; never touches LifeOR2. */
import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const path = resolve(root, "apps/web/.env.local");
let source = await readFile(path, "utf8");
const env = Object.fromEntries(
  source
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i),
        l
          .slice(i + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      ];
    }),
);
for (const name of ["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL"]) {
  const url = new URL(env[name]);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Local setup requires a loopback client Convex deployment");
}
for (const [name, value] of Object.entries({
  LIFEOR_STORE_SECRET: randomBytes(40).toString("base64url"),
  MCP_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
})) {
  if (!env[name]) {
    source += `\n${name}=${value}\n`;
    env[name] = value;
  }
}
await writeFile(path, source);
await chmod(path, 0o600);
const child = Bun.spawn(
  ["bunx", "convex", "env", "set", "LIFEOR_STORE_SECRET"],
  {
    cwd: resolve(root, "packages/backend"),
    stdin: new Blob([env.LIFEOR_STORE_SECRET]),
    stdout: "pipe",
    stderr: "pipe",
  },
);
if ((await child.exited) !== 0)
  throw new Error(
    "Could not configure the client Convex gateway. Start the local Convex deployment first.",
  );
console.log(
  "LifeOR2 client local gateway configured. Existing encryption keys preserved.",
);
