// Tolerant parser for model-written ```knowgap-widget blocks.
// It only repairs punctuation; it never completes truncated JSON, so a block that is
// still streaming keeps returning null and the skeleton stays visible.

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

export function parseWidgetJson(rawCode: string): Record<string, unknown> | null {
  const text = rawCode.trim();
  if (!text) return null;
  const accept = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) && "type" in value
      ? (value as Record<string, unknown>)
      : null;
  try {
    return accept(JSON.parse(text));
  } catch {
    try {
      return accept(JSON.parse(repairWidgetJson(text)));
    } catch {
      return null;
    }
  }
}
