import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createMatcher } from "./ignore.js";

const ALGORITHMS = new Set(["sha256", "sha512"]);

// The size is counted while reading, so size and hash always describe the same bytes, also if the file changes while we read it.
function hashFile(path, algorithm) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    let size = 0;
    createReadStream(path).on("error", reject).on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    }).on("end", () => resolveHash({ size, hash: hash.digest("hex") }));
  });
}

async function collect(base, ignored) {
  const files = [];
  async function visit(dir, rel) {
    for (const dirent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (ignored(childRel, dirent.isDirectory())) continue;
      if (dirent.isDirectory()) await visit(join(dir, dirent.name), childRel);
      else if (dirent.isFile()) files.push({ path: join(dir, dirent.name), rel: childRel });
      // Symbolic links and special files are skipped: their targets can be anywhere.
    }
  }
  await visit(base, "");
  return files;
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

/** The hash of the whole list, which covers every path, size and file hash, so renaming, adding, removing or changing anything changes it. */
export function rootHash(files, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`${f.path}\0${f.size}\0${f.hash}\n`);
  return hash.digest("hex");
}

/**
 * Hashes every regular file below a folder and returns `{ algorithm, root, files: [{ path, size, hash }] }`, where `root` is one
 * hash that stands for the whole folder. Paths use `/` and are sorted, so the result is the same on every machine.
 * Options: `algorithm` ("sha256" default, or "sha512"), `ignore` (.gitignore-style patterns), `concurrency` (default 8).
 * Symbolic links are skipped.
 */
export async function hashDirectory(root, { algorithm = "sha256", ignore = [], concurrency = 8 } = {}) {
  if (!ALGORITHMS.has(algorithm)) throw new RangeError('dir-hash: algorithm must be "sha256" or "sha512"');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("dir-hash: concurrency must be a whole number of at least 1");
  const base = resolve(root);
  if (!(await stat(base)).isDirectory()) throw new TypeError(`dir-hash: ${root} is not a folder`);
  const files = await collect(base, createMatcher(ignore));
  const hashed = await mapWithLimit(files, concurrency, async ({ path, rel }) => {
    return { path: rel, ...(await hashFile(path, algorithm)) };
  });
  return { algorithm, root: rootHash(hashed, algorithm), files: hashed };
}

/**
 * Compares two results of `hashDirectory` (an earlier and a later one) and lists what happened: `added`, `removed`, `modified`
 * (same path, other content) and `renamed` ({ from, to }: the same content under another path). `same` is true if nothing changed.
 */
export function compareManifests(before, after) {
  const was = new Map(before.files.map((f) => [f.path, f]));
  const now = new Map(after.files.map((f) => [f.path, f]));
  const modified = [];
  const added = [];
  const removed = [];
  for (const [path, file] of now) {
    const old = was.get(path);
    if (!old) added.push(file);
    else if (old.hash !== file.hash || old.size !== file.size) modified.push(path);
  }
  for (const [path, file] of was) if (!now.has(path)) removed.push(file);
  // A removed file and an added file with the same content count as a rename (first removed with first added, in order).
  const byContent = new Map();
  added.forEach((file, index) => {
    const key = `${file.size}\0${file.hash}`;
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(index);
  });
  const renamed = [];
  const taken = new Set();
  const stillRemoved = [];
  for (const gone of removed) {
    const candidates = byContent.get(`${gone.size}\0${gone.hash}`);
    const index = candidates?.shift();
    if (index === undefined) stillRemoved.push(gone);
    else {
      renamed.push({ from: gone.path, to: added[index].path });
      taken.add(index);
    }
  }
  removed.length = 0;
  removed.push(...stillRemoved);
  const stillAdded = added.filter((_, index) => !taken.has(index));
  added.length = 0;
  added.push(...stillAdded);
  return { same: !modified.length && !added.length && !removed.length && !renamed.length, modified, added: added.map((f) => f.path), removed: removed.map((f) => f.path), renamed };
}

/** Checks a folder against an earlier result (for example one you saved as JSON): returns what changed. */
export async function verifyDirectory(root, manifest, options = {}) {
  const now = await hashDirectory(root, { ignore: options.ignore, concurrency: options.concurrency, algorithm: manifest.algorithm });
  return compareManifests(manifest, now);
}

/** Writes the hashes in the `sha256sum` format (`<hash>  <path>`), so `sha256sum -c` and other tools can check them. Names with a backslash or a line break are escaped the way GNU does. */
export function toChecksumFile(manifest) {
  return manifest.files.map((f) => (/[\\\n\r]/.test(f.path) ? `\\${f.hash}  ${f.path.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}` : `${f.hash}  ${f.path}`)).join("\n") + (manifest.files.length ? "\n" : "");
}

export async function readManifest(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!data || !Array.isArray(data.files) || typeof data.root !== "string" || !ALGORITHMS.has(data.algorithm)) throw new SyntaxError(`dir-hash: ${path} is not a manifest`);
  const length = data.algorithm === "sha256" ? 64 : 128;
  for (const f of data.files) {
    const ok = f && typeof f.path === "string" && !f.path.includes("\0") && Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.hash === "string" && f.hash.length === length && /^[0-9a-f]+$/.test(f.hash);
    if (!ok) throw new SyntaxError(`dir-hash: ${path} is not a manifest (a file entry is malformed)`);
  }
  if (rootHash(data.files, data.algorithm) !== data.root) throw new SyntaxError(`dir-hash: ${path} has been edited: its root hash does not match its files`);
  return data;
}
