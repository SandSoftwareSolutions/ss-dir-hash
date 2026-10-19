// Gitignore-style patterns, matched without regular expressions: a pattern such as `*a*a*a*a*b` or `**/**/**/**/x` in a
// .gitignore must never be able to make a walk take minutes (a regular expression backtracks badly on those).

// Cut trailing spaces, unless the last one is escaped with a backslash.
function trimTrailing(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end < text.length && end > 0 && text[end - 1] === "\\") end++;
  return text.slice(0, end);
}

function parseClass(body) {
  let negate = false;
  let from = 0;
  if (body[0] === "!" || body[0] === "^") {
    negate = true;
    from = 1;
  }
  const ranges = [];
  for (let i = from; i < body.length; i++) {
    if (i + 2 < body.length && body[i + 1] === "-") {
      ranges.push([body[i].codePointAt(0), body[i + 2].codePointAt(0)]);
      i += 2;
    } else ranges.push([body[i].codePointAt(0), body[i].codePointAt(0)]);
  }
  return { t: "class", negate, ranges };
}

// One path segment of a pattern as a list of tokens: a literal character, ?, a run of *, or a [class].
function tokenize(segment) {
  const chars = Array.from(segment);
  const tokens = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "*") {
      if (tokens.length === 0 || tokens[tokens.length - 1].t !== "star") tokens.push({ t: "star" });
    } else if (ch === "?") tokens.push({ t: "any" });
    else if (ch === "[") {
      const end = chars.indexOf("]", i + 2);
      if (end === -1) tokens.push({ t: "lit", c: "[" });
      else {
        tokens.push(parseClass(chars.slice(i + 1, end)));
        i = end;
      }
    } else if (ch === "\\" && i + 1 < chars.length) tokens.push({ t: "lit", c: chars[++i] });
    else tokens.push({ t: "lit", c: ch });
  }
  return tokens;
}

function inClass(token, ch) {
  const code = ch.codePointAt(0);
  const hit = token.ranges.some(([low, high]) => code >= low && code <= high);
  return hit !== token.negate;
}

// Wildcard matching with one remembered star: time n*m at worst, never exponential.
function matchSegment(tokens, chars) {
  let t = 0;
  let s = 0;
  let starT = -1;
  let starS = 0;
  while (s < chars.length) {
    const token = tokens[t];
    if (token && token.t === "star") {
      starT = t++;
      starS = s;
    } else if (token && (token.t === "any" || (token.t === "lit" && token.c === chars[s]) || (token.t === "class" && inClass(token, chars[s])))) {
      t++;
      s++;
    } else if (starT !== -1) {
      t = starT + 1;
      s = ++starS;
    } else return false;
  }
  while (tokens[t] && tokens[t].t === "star") t++;
  return t === tokens.length;
}

// parts: [{ globstar: false, tokens } | { globstar: true, last }]. A `**` segment matches any number of folders; as the last part
// it matches everything below (at least one segment).
function matchPath(parts, segments, count) {
  let next = new Array(count + 1).fill(false);
  next[count] = true;
  for (let j = parts.length - 1; j >= 0; j--) {
    const part = parts[j];
    const current = new Array(count + 1).fill(false);
    for (let i = count; i >= 0; i--) {
      if (part.globstar) current[i] = part.last ? i < count : next[i] || (i < count && current[i + 1]);
      else current[i] = i < count && next[i + 1] && matchSegment(part.tokens, segments[i]);
    }
    next = current;
  }
  return next[0];
}

/** One line of a .gitignore file, compiled. */
function compile(line) {
  let text = line.replace(/\r$/, "");
  if (text.trim() === "" || text.startsWith("#")) return null;
  text = trimTrailing(text);
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
  const parts = text.split("/").map((segment) => (segment === "**" ? { globstar: true, last: false } : { globstar: false, tokens: tokenize(segment) }));
  if (parts[parts.length - 1].globstar) parts[parts.length - 1].last = true;
  else if (!anchored) parts.unshift({ globstar: true, last: false }); // no slash: matches at any depth
  return { negated, dirOnly, parts, plain: !parts.some((p) => p.globstar) };
}

function matches(rule, segments, count) {
  const { parts } = rule;
  if (rule.plain) {
    if (parts.length !== count) return false;
    for (let i = 0; i < count; i++) if (!matchSegment(parts[i].tokens, segments[i])) return false;
    return true;
  }
  return matchPath(parts, segments, count);
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
  return (relPath, isDirectory = false) => {
    const names = String(relPath).split("/").filter(Boolean);
    const segments = names.map((name) => Array.from(name));
    for (let count = 1; count <= names.length; count++) {
      const isDir = count < names.length || isDirectory;
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (matches(rule, segments, count)) ignored = !rule.negated;
      }
      if (ignored) return true;
    }
    return false;
  };
}
