import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
for (const path of ["extensions", "src", "scripts", "test"].flatMap(files).filter(path => path.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length) throw new Error("Runtime dependencies must stay empty.");
for (const path of [...files("extensions"), ...files("src")]) {
  const code = readFileSync(path, "utf8");
  for (const pattern of [/node:child_process/, /node:(?:http|https|net)["']/, /setInterval\s*\(/,
    /globalThis\.fetch\s*=/, /(?:setGlobalDispatcher|registerTool)\s*\(/]) {
    if (pattern.test(code)) throw new Error("Forbidden runtime side effect in " + path + ": " + pattern);
  }
}
console.log("Syntax, dependency, and runtime-side-effect checks passed.");
