import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("root TypeScript config enables React JSX without weakening strict checks", () => {
  const options = readJson("tsconfig.json").compilerOptions;
  assert.equal(options.jsx, "react-jsx");
  assert.equal(options.strict, true);
  assert.notEqual(options.noCheck, true);
});

test("React 19 JSX and react-dom/client declarations are explicit dependencies", () => {
  const rootPackage = readJson("package.json");
  const demoPackage = readJson("apps/demo/package.json");
  assert.match(demoPackage.dependencies.react, /^19\./);
  assert.match(demoPackage.dependencies["react-dom"], /^19\./);
  assert.match(rootPackage.devDependencies["@types/react"], /^19\./);
  assert.match(rootPackage.devDependencies["@types/react-dom"], /^19\./);
});
