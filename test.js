import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { compareManifests, hashDirectory, readManifest, rootHash, toChecksumFile, verifyDirectory } from "./src/index.js";

const base = mkdtempSync(join(tmpdir(), "dir-hash-"));
after(() => rmSync(base, { recursive: true, force: true }));
let root;
let n = 0;
const put = (rel, content) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
beforeEach(() => {
  root = join(base, `case${n++}`);
  mkdirSync(root);
  put("a.txt", "alpha");
  put("sub/b.txt", "beta");
  put("sub/deep/c.txt", "gamma");
});

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("hashes every file with the right hash, sorted, with / paths", async () => {
  const m = await hashDirectory(root);
  assert.equal(m.algorithm, "sha256");
  assert.deepEqual(m.files, [
    { path: "a.txt", size: 5, hash: sha("alpha") },
    { path: "sub/b.txt", size: 4, hash: sha("beta") },
    { path: "sub/deep/c.txt", size: 5, hash: sha("gamma") }
  ]);
  assert.equal(m.root, rootHash(m.files));
});

test("sha512 and the sha256sum file format", async () => {
  const m = await hashDirectory(root, { algorithm: "sha512" });
  assert.equal(m.files[0].hash, createHash("sha512").update("alpha").digest("hex"));
  const text = toChecksumFile(await hashDirectory(root));
  assert.equal(text.split("\n")[0], `${sha("alpha")}  a.txt`);
  assert.equal(toChecksumFile({ files: [] }), "");
});

test("the same content gives the same root hash, whatever the order of creation", async () => {
  const other = join(base, "other");
  mkdirSync(other);
  for (const [rel, content] of [["sub/deep/c.txt", "gamma"], ["a.txt", "alpha"], ["sub/b.txt", "beta"]]) {
    mkdirSync(dirname(join(other, rel)), { recursive: true });
    writeFileSync(join(other, rel), content);
  }
  assert.equal((await hashDirectory(other)).root, (await hashDirectory(root)).root);
});

test("any change changes the root hash: content, rename, add, remove", async () => {
  const before = (await hashDirectory(root)).root;
  put("a.txt", "ALPHA");
  const changed = (await hashDirectory(root)).root;
  assert.notEqual(changed, before);
  put("a.txt", "alpha");
  renameSync(join(root, "a.txt"), join(root, "z.txt"));
  const renamed = (await hashDirectory(root)).root;
  assert.notEqual(renamed, before);
  renameSync(join(root, "z.txt"), join(root, "a.txt"));
  put("new.txt", "");
  assert.notEqual((await hashDirectory(root)).root, before);
  unlinkSync(join(root, "new.txt"));
  assert.equal((await hashDirectory(root)).root, before);
});

test("compare tells modified, added, removed and renamed", async () => {
  const before = await hashDirectory(root);
  put("a.txt", "changed");
  renameSync(join(root, "sub/b.txt"), join(root, "sub/b-renamed.txt"));
  unlinkSync(join(root, "sub/deep/c.txt"));
  put("brand-new.txt", "new");
  const changes = compareManifests(before, await hashDirectory(root));
  assert.deepEqual(changes, { same: false, modified: ["a.txt"], added: ["brand-new.txt"], removed: ["sub/deep/c.txt"], renamed: [{ from: "sub/b.txt", to: "sub/b-renamed.txt" }] });
  assert.equal(compareManifests(before, before).same, true);
});

test("verifyDirectory finds changes against a saved manifest", async () => {
  const saved = JSON.parse(JSON.stringify(await hashDirectory(root)));
  assert.equal((await verifyDirectory(root, saved)).same, true);
  put("sub/b.txt", "tampered");
  assert.deepEqual((await verifyDirectory(root, saved)).modified, ["sub/b.txt"]);
});

test("ignore patterns leave files out", async () => {
  put("debug.log", "x");
  put("node_modules/p/index.js", "x");
  const m = await hashDirectory(root, { ignore: ["*.log", "node_modules/"] });
  assert.deepEqual(m.files.map((f) => f.path), ["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
});

test("symbolic links are skipped, not followed", { skip: process.platform === "win32" }, async () => {
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(root, "link.txt"));
  symlinkSync(root, join(root, "loop"));
  const m = await hashDirectory(root);
  assert.deepEqual(m.files.map((f) => f.path), ["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
});

test("a saved manifest that was edited by hand is detected", async () => {
  const path = join(base, "manifest.json");
  const m = await hashDirectory(root);
  writeFileSync(path, JSON.stringify(m));
  assert.equal((await readManifest(path)).root, m.root);
  const forged = JSON.parse(JSON.stringify(m));
  forged.files[0].hash = sha("evil");
  writeFileSync(path, JSON.stringify(forged));
  await assert.rejects(readManifest(path), /has been edited/);
  writeFileSync(path, "{}");
  await assert.rejects(readManifest(path), /not a manifest/);
});

test("a big file is hashed as a stream", async () => {
  put("big.bin", Buffer.alloc(5_000_000, 7));
  const m = await hashDirectory(root);
  assert.equal(m.files.find((f) => f.path === "big.bin").hash, createHash("sha256").update(Buffer.alloc(5_000_000, 7)).digest("hex"));
});

test("bad arguments", async () => {
  await assert.rejects(hashDirectory(root, { algorithm: "md5" }), RangeError);
  await assert.rejects(hashDirectory(root, { concurrency: 0 }), RangeError);
  await assert.rejects(hashDirectory(join(root, "a.txt")), TypeError);
  await assert.rejects(hashDirectory(join(root, "nope")), { code: "ENOENT" });
});
