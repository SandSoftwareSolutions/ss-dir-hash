/** One line of a .gitignore file, compiled. */
function compile(line) {
  let text = line.replace(/\r$/, "");
  if (text.trim() === "" || text.startsWith("#")) return null;
  // Trailing spaces are dropped unless escaped with a backslash.
  text = text.replace(/(?<!\\)\s+$/, "");
  let negated = false;
  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) text = text.slice(1);
  if (text === "") return null;
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.replace(/\/+$/, "");
  if (text === "") return null;
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);
  return { negated, dirOnly, anchored, regex: toRegex(text, anchored) };
}

function toRegex(glob, anchored) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2] === "/" || i + 2 === glob.length;
        if (before && after) {
          if (glob[i + 2] === "/") {
            out += "(?:.*/)?"; // "**/" matches zero or more folders
            i += 2;
          } else {
            out += ".*"; // trailing "/**" matches everything below
            i += 1;
          }
          continue;
        }
      }
      out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (ch === "\\" && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`);
}

/**
 * A matcher for .gitignore-style patterns (an array of lines, or one text). Returns `ignored(relPath, isDirectory)`.
 * Rules: `*`, `?`, `[a-z]`, `**` (any number of folders), a leading or inner `/` anchors the pattern to the root, a trailing `/`
 * matches folders only, `!` re-includes (the last matching pattern wins), `#` comments. As in git, a file inside an ignored
 * folder stays ignored whatever a later `!` says.
 */
export function createMatcher(patterns = []) {
  const lines = typeof patterns === "string" ? patterns.split("\n") : patterns;
  const rules = lines.map(compile).filter(Boolean);
  const decide = (path, isDir) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(path)) ignored = !rule.negated;
    }
    return ignored;
  };
  return (relPath, isDirectory = false) => {
    const segments = String(relPath).split("/").filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      const isDir = i < segments.length || isDirectory;
      if (decide(segments.slice(0, i).join("/"), isDir)) return true;
    }
    return false;
  };
}
