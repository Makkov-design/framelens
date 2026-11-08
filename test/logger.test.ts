import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture(level: Parameters<typeof createLogger>[0], secrets: string[] = []) {
  const lines: string[] = [];
  const logger = createLogger(level, (line) => lines.push(line), secrets);
  return { logger, lines };
}

describe("createLogger", () => {
  it("drops messages below the configured level", () => {
    const { logger, lines } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toEqual(["[framelens] WARN w", "[framelens] ERROR e"]);
  });

  it("appends fields as JSON", () => {
    const { logger, lines } = capture("info");
    logger.info("done", { videoId: "abc", ms: 12 });
    expect(lines).toEqual(['[framelens] INFO done {"videoId":"abc","ms":12}']);
  });

  it("redacts secrets everywhere in the line", () => {
    const { logger, lines } = capture("debug", ["s3cret"]);
    logger.error("failed with key s3cret", { url: "https://x?key=s3cret" });
    expect(lines.join("\n")).not.toContain("s3cret");
    expect(lines[0]).toContain("[redacted]");
  });

  it("serializes errors by message", () => {
    const { logger, lines } = capture("error");
    logger.error("boom", { error: new Error("bad thing") });
    expect(lines[0]).toContain('"error":"Error: bad thing"');
  });
});
