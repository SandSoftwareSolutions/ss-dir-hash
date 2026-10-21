# @sandsoftwaresolutions/dir-hash

[![CI](https://github.com/SandSoftwareSolutions/ss-dir-hash/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-dir-hash/actions/workflows/ci.yml)

One fingerprint for a whole folder, and a list of exactly what changed since last time: modified, added, removed, renamed. The JavaScript little sibling of [Assay](https://github.com/SandSoftwareSolutions/assay). No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/dir-hash
```

Works with `import` and `require()`, and ships TypeScript types for both.

## Usage

```js
import { hashDirectory, verifyDirectory } from "@sandsoftwaresolutions/dir-hash";
import { writeFile, readFile } from "node:fs/promises";

// Take a fingerprint of a build and save it
const manifest = await hashDirectory("./dist", { ignore: ["*.map", "node_modules/"] });
console.log(manifest.root);            // one hash for the whole folder
await writeFile("dist.manifest.json", JSON.stringify(manifest));

// Later: what changed?
const saved = JSON.parse(await readFile("dist.manifest.json", "utf8"));
const changes = await verifyDirectory("./dist", saved);
// { same: false, modified: ["app.js"], added: [], removed: ["old.css"], renamed: [{ from: "a.png", to: "logo.png" }] }
```

`compareManifests(before, after)` compares two results you already have. `toChecksumFile(manifest)` writes the lines in `sha256sum` format (`<hash>  <path>`) so `sha256sum -c` can check them too (names with a backslash or a line break are escaped as GNU does).

## How it works

- Every regular file is hashed with SHA-256 (or `algorithm: "sha512"`), streamed, so big files do not fill memory; `concurrency` (default 8) files at a time.
- `root` is a hash over the sorted list of `path`, `size` and file hash. Changing, renaming, adding or removing any file changes it. The same content gives the same `root` on every machine, whatever the order the files were created in.
- Paths always use `/`. Symbolic links below the folder are skipped, not followed; the folder you pass in may itself be a link to a folder. Names are compared as stored (UTF-16 order, no Unicode normalisation), so macOS (decomposed accents) can give another `root` than Linux for the same accented names.
- Not covered by the hash: permissions, owners, timestamps, empty folders and links. Only regular files count.
- `size` is the number of bytes that were hashed, so it always matches `hash`, also if a file changes while it is read.
- `readManifest` refuses a manifest that has an unknown algorithm or malformed entries.
- `ignore` takes `.gitignore`-style patterns (`*.log`, `build/`, `!keep.txt`, `**/tmp`), matched without regular expressions, so a hostile pattern cannot make the walk slow.
- A rename shows up as `renamed`, not as one removed plus one added file.

## What it is not

A fingerprint shows that something changed, not who did it, and anyone who can change the folder can also recompute the fingerprint. `readManifest(path)` notices a manifest file that was edited **by accident** (its `root` no longer matches its files), but an attacker can fix both. For protection against that, keep the manifest somewhere else, or sign it, which is what Assay does (`assay seal --key`).
