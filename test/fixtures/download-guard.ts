// Runs every download path against a hostile local server in a process of its own: endless and broken encodings,
// stalls, unknown encodings, oversize bodies and cut connections. Each call must settle with an error, and the
// process must still be alive after every time limit has passed (an unhandled stream error would end it).
// Prints one JSON line with what each call returned.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, gzipSync } from "node:zlib";
import { downloadFile } from "../../src/exact/http.js";
import { fetchWithCobalt } from "../../src/sources/cobalt.js";
import { download } from "../../src/browser/capture.js";

const LIMIT_MS = 600;
const dir = mkdtempSync(join(tmpdir(), "framelens-guard-"));
const zeros = Buffer.alloc(64 * 1024);

const server = createServer((req, res) => {
  const path = req.url ?? "/";
  if (req.method === "POST") {
    // The cobalt instance: always a tunnel to one of the hostile answers below.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const target = JSON.parse(body).url.replace(/^.*\/\/[^/]+/, "");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "tunnel", url: `${origin}${target}`, filename: "x.mp4" }));
    });
    return;
  }
  if (path === "/endless-gzip") {
    res.writeHead(200, { "content-encoding": "gzip", "content-type": "video/mp4" });
    const gz = createGzip();
    gz.pipe(res);
    const feed = () => { while (gz.write(zeros)); };
    gz.on("drain", feed);
    feed();
    res.on("close", () => gz.destroy());
    return;
  }
  if (path === "/not-gzip-open") {
    res.writeHead(200, { "content-encoding": "gzip", "content-type": "video/mp4" });
    res.write("this is not gzip at all, and the connection stays open");
    return;
  }
  if (path === "/stall-gzip") {
    res.writeHead(200, { "content-encoding": "gzip", "content-type": "video/mp4" });
    res.write(gzipSync(Buffer.alloc(1024 * 1024)).subarray(0, 100));
    return;
  }
  if (path === "/stall-plain") {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.from("00000018667479706d703432", "hex"));
    return;
  }
  if (path === "/zstd-open") {
    res.writeHead(200, { "content-encoding": "zstd", "content-type": "video/mp4" });
    res.write("zstd bytes that are never read");
    return;
  }
  if (path === "/endless-plain") {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.from("00000018667479706d703432", "hex"));
    const feed = () => { while (res.write(zeros)); };
    res.on("drain", feed);
    feed();
    return;
  }
  if (path === "/cut") {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": "1000000" });
    res.write(Buffer.from("00000018667479706d703432", "hex"));
    setTimeout(() => req.socket.destroy(), 50);
    return;
  }
  res.writeHead(404).end();
});

let origin = "";
await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const settle = async (name: string, run: () => Promise<unknown>) => {
  const started = Date.now();
  const timer = new Promise<string>((done) => setTimeout(() => done("never settled"), LIMIT_MS + 5_000).unref());
  const outcome = await Promise.race([run().then(() => "resolved", (e: Error) => `rejected: ${e.message}`), timer]);
  return { name, outcome, ms: Date.now() - started };
};

const paths = ["/endless-gzip", "/not-gzip-open", "/stall-gzip", "/stall-plain", "/zstd-open", "/endless-plain", "/cut"];
const results = [];
for (const p of paths) {
  results.push(await settle(`exact ${p}`, () => downloadFile(`${origin}${p}`, join(dir, "exact"), undefined, undefined, LIMIT_MS)));
  results.push(
    await settle(`cobalt ${p}`, () =>
      fetchWithCobalt({ url: `https://www.instagram.com${p}`, mediaDir: join(dir, `cobalt${p}`), env: { FRAMELENS_COBALT_URL: `${origin}/` }, maxBytes: 1024 * 1024, timeoutMs: LIMIT_MS }),
    ),
  );
}
for (const p of ["/endless-plain", "/cut"]) {
  results.push(await settle(`capture ${p}`, () => download(`${origin}${p}`, join(dir, `capture${p.replace("/", "-")}.mp4`), 1024 * 1024)));
}
// Past every time limit: an unhandled error from a stream left open would have ended the process by now.
await new Promise((done) => setTimeout(done, LIMIT_MS * 3));
server.closeAllConnections();
server.close();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ alive: true, results })}\n`);
