// Tolerant parser for model-written ```knowgap-widget blocks.
// parseWidgetJson only repairs punctuation and returns null for truncated JSON;
// parsePartialWidgetJson closes a block that is still streaming so it can be previewed.

function closesString(raw: string, quoteIndex: number, isKey: boolean): boolean {
  let i = quoteIndex + 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length) return !isKey;
  const next = raw[i];
  if (isKey) return next === ":";
  if (next === "}" || next === "]") return true;
  if (next !== ",") return false;
  // A comma closes the string only when the next token can start a JSON value or key.
  i += 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  return i >= raw.length || /["{}[\]\-\dtfn]/.test(raw[i]);
}

/** Escape stray inner quotes / raw newlines inside strings and drop trailing commas. */
export function repairWidgetJson(raw: string): string {
  let out = "";
  let inString = false;
  let isKey = false;
  let escaped = false;
  const containers: Array<"{" | "["> = [];
  let afterColon = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
      } else if (char === "\\") {
        escaped = true;
        out += char;
      } else if (char === '"') {
        if (closesString(raw, index, isKey)) {
          inString = false;
          out += char;
        } else {
          out += '\\"';
        }
      } else if (char === "\n") {
        out += "\\n";
      } else if (char === "\r") {
        out += "";
      } else {
        out += char;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      isKey = containers[containers.length - 1] === "{" && !afterColon;
      out += char;
      continue;
    }
    if (char === "{") {
      containers.push("{");
      afterColon = false;
    } else if (char === "[") {
      containers.push("[");
      afterColon = false;
    } else if (char === "}" || char === "]") {
      containers.pop();
      afterColon = false;
    } else if (char === ":") {
      afterColon = true;
    } else if (char === ",") {
      afterColon = false;
      let next = index + 1;
      while (next < raw.length && /\s/.test(raw[next])) next += 1;
      if (raw[next] === "}" || raw[next] === "]") continue;
    }
    out += char;
  }
  return out;
}

const acceptWidget = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) && "type" in value
    ? (value as Record<string, unknown>)
    : null;

export function parseWidgetJson(rawCode: string): Record<string, unknown> | null {
  const text = rawCode.trim();
  if (!text) return null;
  try {
    return acceptWidget(JSON.parse(text));
  } catch {
    try {
      return acceptWidget(JSON.parse(repairWidgetJson(text)));
    } catch {
      return null;
    }
  }
}

/**
 * Close a truncated JSON prefix: cut back to the last complete value, then append the
 * missing brackets. An unfinished string value is kept and closed, so long text shows as it
 * arrives; an unfinished key, number or literal is dropped.
 */
export function closeTruncatedJson(raw: string): string {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let isKey = false;
  let escaped = false;
  let afterColon = false;
  let cut = { at: 0, stack: [] as Array<"{" | "[">, quote: false };
  const mark = (at: number) => {
    cut = { at, stack: [...stack], quote: false };
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (!isKey) mark(index + 1);
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      isKey = stack[stack.length - 1] === "{" && !afterColon;
    } else if (char === "{" || char === "[") {
      stack.push(char);
      afterColon = false;
      mark(index + 1);
    } else if (char === "}" || char === "]") {
      stack.pop();
      afterColon = false;
      mark(index + 1);
    } else if (char === ":") {
      afterColon = true;
    } else if (char === ",") {
      afterColon = false;
      mark(index);
    }
  }
  if (inString && !isKey) {
    // Drop a dangling backslash so the closing quote is not escaped.
    cut = { at: escaped ? raw.length - 1 : raw.length, stack: [...stack], quote: true };
  }
  const closers = cut.stack.reverse().map((open) => (open === "{" ? "}" : "]")).join("");
  return raw.slice(0, cut.at) + (cut.quote ? '"' : "") + closers;
}

/** Best-effort view of a block that is still streaming. Fields may be missing or cut short. */
export function parsePartialWidgetJson(rawCode: string): Record<string, unknown> | null {
  const text = rawCode.trim();
  if (!text.startsWith("{")) return null;
  try {
    return acceptWidget(JSON.parse(closeTruncatedJson(repairWidgetJson(text))));
  } catch {
    return null;
  }
}
