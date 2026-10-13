import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { zipSync } from "fflate";

const root = resolve("dist");
const files = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && !entry.name.endsWith(".zip")) {
      files[`qrmax-transfer/${relative(root, path).split("\\").join("/")}`] = new Uint8Array(await readFile(path));
    }
  }
}
await collect(root);
for (const name of ["README.md", "README.en.md", "docs/workstation.png"]) {
  files[name] = new Uint8Array(await readFile(name));
}
await writeFile(resolve(root, "maupload-offline.zip"), zipSync(files, { level: 9 }));
console.log("Offline bundle: dist/maupload-offline.zip");
