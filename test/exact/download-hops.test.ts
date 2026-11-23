// `exact` link downloads follow redirects by hand, with the same per-hop check as the cobalt download: the link's own
// host is the user's choice, but a redirect to another host must be https on the public internet. A page cannot send
// the download to this computer, the local network or a cloud metadata address.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadFile, type FetchLike } from "../../src/exact/http.js";

const dir = mkdtempSync(join(tmpdir(), "framelens-hops-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BODY = JSON.stringify({ v: "5.7.0", fr: 30, ip: 0, op: 30, w: 10, h: 10, layers: [] });
const ok = () => ({ ok: true, status: 200, body: new Response(BODY).body, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });
const redirect = (location: string) => ({ ok: false, status: 302, headers: { get: (n: string) => (n === "location" ? location : null) }, body: null, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });
const publicLookup = async () => ["93.184.215.14"];

/** A fake fetch that answers each address from a table and records what was asked. */
function routes(table: Record<string, () => ReturnType<typeof ok> | ReturnType<typeof redirect>>) {
  const asked: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    asked.push(url);
    expect(init?.redirect).toBe("manual");
    const answer = table[url];
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return answer();
  };
  return { fetchImpl, asked };
}

describe("exact link download redirects", () => {
  it("refuses a redirect to a cloud metadata address, before connecting to it", async () => {
    const { fetchImpl, asked } = routes({ "https://cdn.example.com/anim.json": () => redirect("http://169.254.169.254/latest/meta-data/") });
    await expect(downloadFile("https://cdn.example.com/anim.json", join(dir, "a"), fetchImpl, publicLookup)).rejects.toThrow(/another host that is not https/);
    expect(asked).toEqual(["https://cdn.example.com/anim.json"]);
  });

  it("refuses an https redirect to a name that resolves to the local network", async () => {
    const { fetchImpl, asked } = routes({ "https://cdn.example.com/anim.json": () => redirect("https://intranet-box.example.org/x.json") });
    const lookup = async (host: string) => (host === "intranet-box.example.org" ? ["10.0.0.5"] : ["93.184.215.14"]);
    await expect(downloadFile("https://cdn.example.com/anim.json", join(dir, "b"), fetchImpl, lookup)).rejects.toThrow(/intranet-box\.example\.org, which is on this computer or the local network/);
    expect(asked).toHaveLength(1);
  });

  it("refuses redirects to localhost names and IPv6 loopback", async () => {
    for (const target of ["https://localhost/x.json", "https://[::1]/x.json", "https://127.0.0.1/x.json"]) {
      const { fetchImpl } = routes({ "https://cdn.example.com/anim.json": () => redirect(target) });
      await expect(downloadFile("https://cdn.example.com/anim.json", join(dir, "c"), fetchImpl, publicLookup), target).rejects.toThrow(/this computer or the local network/);
    }
  });

  it("follows a redirect to a public https host and saves the file", async () => {
    const { fetchImpl, asked } = routes({
      "https://lottie.host/abc": () => redirect("https://assets.lottie.host/abc/anim.json"),
      "https://assets.lottie.host/abc/anim.json": ok,
    });
    const file = await downloadFile("https://lottie.host/abc", join(dir, "d"), fetchImpl, publicLookup);
    expect(readFileSync(file, "utf8")).toBe(BODY);
    expect(asked).toEqual(["https://lottie.host/abc", "https://assets.lottie.host/abc/anim.json"]);
  });

  it("stops after five redirects", async () => {
    const { fetchImpl } = routes({ "https://cdn.example.com/loop.json": () => redirect("/loop.json") });
    await expect(downloadFile("https://cdn.example.com/loop.json", join(dir, "e"), fetchImpl, publicLookup)).rejects.toThrow(/redirects too often/);
  });
});

describe("exact link download over real sockets", () => {
  let a: Server;
  let b: Server;
  let aUrl: string;
  let bUrl: string;
  beforeAll(async () => {
    const listen = (server: Server) => new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
    b = createServer((_req, res) => res.end(BODY));
    bUrl = await listen(b);
    a = createServer((req, res) => {
      // A precompressed asset, sent gzip-encoded whatever the client asked for (as S3 and some CDNs do).
      if (req.url === "/gz.json") return void res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" }).end(gzipSync(BODY));
      // 40 MB of zeros, a few KB on the wire: the cap must apply to what it unpacks to.
      if (req.url === "/bomb.json") return void res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(40 * 1024 * 1024)));
      if (req.url === "/same") return void res.writeHead(302, { location: "/file.json" }).end();
      if (req.url === "/away") return void res.writeHead(302, { location: `${bUrl}/secret.json` }).end();
      res.end(BODY);
    });
    aUrl = await listen(a);
  });
  afterAll(() => {
    a.close();
    b.close();
  });

  it("downloads from the local host the user named, also through a redirect on that host", async () => {
    const file = await downloadFile(`${aUrl}/same`, join(dir, "f"));
    expect(readFileSync(file, "utf8")).toBe(BODY);
  });

  it("saves a gzip-encoded answer decoded, and caps what it unpacks to", async () => {
    const file = await downloadFile(`${aUrl}/gz.json`, join(dir, "h"));
    expect(readFileSync(file, "utf8")).toBe(BODY);
    await expect(downloadFile(`${aUrl}/bomb.json`, join(dir, "i"))).rejects.toThrow(/larger than 30 MB/);
  });

  it("refuses a redirect from that host to another local service", async () => {
    await expect(downloadFile(`${aUrl}/away`, join(dir, "g"))).rejects.toThrow(/another host that is not https/);
  });
});
