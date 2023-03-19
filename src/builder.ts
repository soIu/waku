import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import url from "node:url";

import { build } from "vite";
import type { Plugin } from "vite";
import * as swc from "@swc/core";

import type { Config } from "./config.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

const rscPlugin = (): Plugin => {
  const code = `
globalThis.__webpack_require__ = function (id) {
  return import(id);
};`;
  return {
    name: "rscPlugin",
    async transformIndexHtml() {
      return [
        {
          tag: "script",
          children: code,
          injectTo: "body",
        },
      ];
    },
  };
};

const walkDirSync = (dir: string, callback: (filePath: string) => void) => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((dirent) => {
    const filePath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      walkDirSync(filePath, callback);
    } else {
      callback(filePath);
    }
  });
};

const getEntryFiles = (dir: string) => {
  const files: string[] = [];
  walkDirSync(dir, (fname) => {
    if (fname.endsWith(".ts") || fname.endsWith(".tsx")) {
      const mod = swc.parseFileSync(fname, {
        syntax: "typescript",
        tsx: fname.endsWith(".tsx"),
      });
      for (const item of mod.body) {
        if (
          item.type === "ExpressionStatement" &&
          item.expression.type === "StringLiteral" &&
          item.expression.value === "use client"
        ) {
          files.push(fname);
        }
      }
    }
  });
  return files;
};

const compileFiles = (dir: string, dist: string) => {
  walkDirSync(dir, (fname) => {
    const relativePath = path.relative(dir, fname);
    if (relativePath.startsWith(dist)) {
      return;
    }
    if (fname.endsWith(".ts") || fname.endsWith(".tsx")) {
      const { code } = swc.transformFileSync(fname, {
        jsc: {
          parser: {
            syntax: "typescript",
            tsx: fname.endsWith(".tsx"),
          },
          transform: {
            react: {
              runtime: "automatic",
            },
          },
        },
        module: {
          type: "commonjs",
        },
      });
      const destFile = path.join(
        dir,
        dist,
        relativePath.replace(/\.tsx?$/, ".js")
      );
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, code);
    }
  });
};

export async function runBuild(config: Config = {}) {
  const dir = path.resolve(config.build?.dir || ".");
  const basePath = config.build?.basePath || "/";
  const distPath = config.files?.dist || "dist";
  const publicPath = path.join(distPath, config.files?.public || "public");
  const indexHtmlFile = path.join(dir, config.files?.indexHtml || "index.html");
  const entriesFile = path.join(
    dir,
    distPath,
    config.files?.entriesJs || "entries.js"
  );

  const entryFiles = Object.fromEntries(
    getEntryFiles(dir).map((fname, i) => [`rsc${i}`, fname])
  );
  const output = await build({
    root: dir,
    base: basePath,
    resolve: {
      alias: {
        "wakuwork/client": path.resolve(__dirname, "client.js"),
      },
    },
    plugins: [rscPlugin()],
    build: {
      outDir: publicPath,
      rollupOptions: {
        input: {
          main: indexHtmlFile,
          ...entryFiles,
        },
      },
    },
  });
  const clientEntries: Record<string, string> = {};
  if ("output" in output) {
    for (const item of output.output) {
      const { name, fileName } = item;
      const entryFile = name && entryFiles[name];
      if (entryFile) {
        clientEntries[path.relative(dir, entryFile)] = fileName;
      }
    }
  }
  console.log("clientEntries", clientEntries);

  compileFiles(dir, distPath);
  fs.appendFileSync(
    entriesFile,
    `exports.clientEntries=${JSON.stringify(clientEntries)};`
  );
  const origPackageJson = require(path.join(dir, "package.json"));
  const packageJson = {
    name: origPackageJson.name,
    version: origPackageJson.version,
    private: true,
    type: "commonjs",
    dependencies: origPackageJson.dependencies,
  };
  fs.writeFileSync(
    path.join(dir, distPath, "package.json"),
    JSON.stringify(packageJson, null, 2)
  );
}
