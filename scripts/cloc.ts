import { execFileSync } from "node:child_process";
import { join } from "node:path";

const kind = process.argv[2];
if (kind !== "source" && kind !== "tests") {
  console.error("Usage: node scripts/cloc.ts <source|tests>");
  process.exit(1);
}

const filter = (() => {
  if (kind === "source") {
    return "--not-match-f=[.]test[.]ts$";
  }
  return "--match-f=[.]test[.]ts$";
})();

const output = execFileSync(
  join(process.cwd(), "node_modules/.bin/cloc"),
  ["src", "--json", "--quiet", "--timeout=0", filter],
  { encoding: "utf8" },
);
const result = JSON.parse(output) as { SUM: { code: number } };
console.log(result.SUM.code);
