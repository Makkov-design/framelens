import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specFromPage } from "../../src/browser/web.js";
import { exportSpec } from "../../src/export/exporters.js";
import { tempDir } from "../media/fixtures.js";

describe("a hostile source title never becomes code", () => {
  it("keeps a multi-line caption on one comment line in every script target", () => {
    const spec = specFromPage(
      {
        url: "https://example.test/",
        title: "nice reel\u2028app.project.close();\nrequire('child_process').exec('calc')",
        viewport: { width: 640, height: 360 },
        scrollHeight: 360,
        animations: [{ kind: "waapi", name: "in", target: "x", delay: 0, duration: 500, iterations: 1, easing: "ease-out", keyframes: [], properties: ["opacity"], scrollY: 0 }],
        fonts: [],
        colors: [{ hex: "#112233", area: 1 }],
        gsap: false,
      },
      "test",
    );
    for (const target of ["after-effects", "remotion"] as const) {
      const dir = tempDir();
      try {
        const files = exportSpec(spec, target, dir);
        for (const file of files.filter((f) => /\.(jsx|ts|tsx)$/.test(f))) {
          const code = readFileSync(file, "utf8");
          for (const line of code.split(/\r?\n|\u2028|\u2029/)) {
            if (line.includes("app.project.close") || line.includes("child_process")) expect(line.trimStart().startsWith("//")).toBe(true);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
