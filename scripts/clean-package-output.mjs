import fs from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const manifestPath = path.join(packageRoot, "package.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error(`Refusing to clean package output without ${manifestPath}`);
}

fs.rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });
