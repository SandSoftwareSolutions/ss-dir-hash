export interface FileHash { path: string; size: number; hash: string }
export interface Manifest { algorithm: "sha256" | "sha512"; root: string; files: FileHash[] }

export interface HashOptions {
  algorithm?: "sha256" | "sha512";
  /** Gitignore-style patterns. */
  ignore?: string | readonly string[];
  concurrency?: number;
}

export interface Changes {
  same: boolean;
  modified: string[];
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
}

export function hashDirectory(root: string, options?: HashOptions): Promise<Manifest>;
export function compareManifests(before: Manifest, after: Manifest): Changes;
export function verifyDirectory(root: string, manifest: Manifest, options?: Pick<HashOptions, "ignore" | "concurrency">): Promise<Changes>;
export function rootHash(files: readonly FileHash[], algorithm?: "sha256" | "sha512"): string;
export function toChecksumFile(manifest: Manifest): string;
export function readManifest(path: string): Promise<Manifest>;
