import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("pdf-content-transform.js", "utf8").replace(
  'from "./pdf-lib-shim.js"',
  'from "pdf-lib"',
);
writeFileSync("scripts/pdf-content-transform.node.mjs", source);
