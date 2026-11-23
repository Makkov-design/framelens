import { readdirSync } from "node:fs";

let muslCache: boolean | undefined;

/**
 * True on a Linux whose C library is musl (Alpine). Node's report names the glibc version on glibc systems; without
 * one, the musl loader in /lib decides. Anything unknown counts as glibc, the build most Linux systems run.
 */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  muslCache ??= detectMusl();
  return muslCache;
}

function detectMusl(): boolean {
  const report = process.report as (NodeJS.ProcessReport & { excludeNetwork?: boolean }) | undefined;
  if (report) {
    // The report would otherwise resolve every open socket's address (synchronously, on Node 20).
    const excluded = report.excludeNetwork;
    try {
      report.excludeNetwork = true;
      const header = (report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
      if (header?.glibcVersionRuntime) return false;
    } catch {
      // Fall through to the loader check.
    } finally {
      report.excludeNetwork = excluded;
    }
  }
  try {
    return readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}
