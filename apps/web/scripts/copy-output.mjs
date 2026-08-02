import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const source = path.join(appRoot, "out");
const target = path.join(repoRoot, "research", "site");

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

async function cleanDirectory(directory) {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    const info = await stat(filePath);
    if (info.isDirectory()) {
      if (entry === "_next" || entry.startsWith("__next")) {
        await rm(filePath, { recursive: true, force: true });
        continue;
      }
      await cleanDirectory(filePath);
      if ((await readdir(filePath)).length === 0) {
        await rm(filePath, { recursive: true, force: true });
      }
      continue;
    }
    if (
      filePath.endsWith(".txt") &&
      !filePath.includes(`${path.sep}assets${path.sep}`)
    ) {
      await rm(filePath, { force: true });
      continue;
    }
    if (!filePath.endsWith(".html")) continue;

    const html = await readFile(filePath, "utf8");
    const staticHtml = html
      .replace(/<link\b[^>]+href=["']\/_next\/[^>]*>/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (script) =>
        /^<script\b[^>]+src=["'][^"']*assets\/research\.js["']/.test(script)
          ? script
          : "",
      )
      .replace(/<div hidden="">[\s\S]*?<\/div>/g, "")
      .replace(/<!--\s*-->|<!--\$-->|<!--\/\$-->|<!--\$\?-->|<!--\$!-->/g, "")
      .replace(/<link\b[^>]+rel=["']preload["'][^>]+as=["']script["'][^>]*>/g, "");
    await writeFile(filePath, staticHtml);
  }
}

await cleanDirectory(target);
await rm(path.join(target, "404.html"), { force: true });
await rm(path.join(target, "_not-found.html"), { force: true });
