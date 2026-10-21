/**
 * Pure parsing, validation and geometry for the vision widgets. No React and no imports, so
 * tests/vision-data.test.cjs loads this file directly.
 *
 * Boxes are [ymin, xmin, ymax, xmax] on a 0-1000 grid relative to the image. The backend
 * (app/vision/grounding.py) normalizes every provider's coordinate convention to this.
 */

export type Box = [number, number, number, number];
export type Effort = "off" | "low" | "medium" | "high";

export interface Route {
  effort: Effort;
  reason: string;
  source: "auto" | "user";
}

const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high"];
export const EFFORT_LABEL: Record<Effort, string> = { off: "标准", low: "低", medium: "中", high: "高" };
/** red-600: white badge text on it passes WCAG AA contrast */
export const DEFAULT_ANNOTATION_COLOR = "#dc2626";
const MAX_ANNOTATIONS = 40;
const MAX_BRANCHES = 80;
const IMAGE_ID_RE = /^img_[A-Za-z0-9_-]{16,40}$/;
const NETLIST_ID_RE = /^net_[A-Za-z0-9_-]{16,40}$/;

export function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function safeColor(value: unknown): string {
  const text = asText(value);
  return /^#[0-9a-f]{3,8}$/i.test(text) || /^[a-z]{3,20}$/i.test(text) ? text : DEFAULT_ANNOTATION_COLOR;
}

export function safeImageSrc(value: unknown): string {
  const text = asText(value).trim();
  return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|bmp);base64,|blob:|\/)/i.test(text) ? text : "";
}

export function parseRoute(raw: unknown): Route | null {
  const item = asRecord(raw);
  const effort = EFFORTS.find((value) => value === item.effort);
  if (!effort) return null;
  return { effort, reason: asText(item.reason).slice(0, 80), source: item.source === "user" ? "user" : "auto" };
}

/** Accepts 0-1000 or 0-1 boxes, reorders reversed corners and clamps to the image. */
export function parseBox(raw: unknown): Box | null {
  const values = asList(raw).map((value) => (typeof value === "number" ? value : Number(asText(value, "x"))));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const scale = Math.max(...values.map(Math.abs)) <= 1 ? 1000 : 1;
  const [y1, x1, y2, x2] = values.map((value) => Math.min(1000, Math.max(0, value * scale)));
  return [Math.min(y1, y2), Math.min(x1, x2), Math.max(y1, y2), Math.max(x1, x2)];
}

// ---------------------------------------------------------------- image_annotator

export interface Annotation {
  id: string;
  box: Box;
  shape: "ellipse" | "rect";
  text: string;
  color: string;
  /** index of the annotation this one points at, or null */
  arrowTo: number | null;
}

export interface AnnotatorData {
  title: string;
  /** short judgement from the logic model */
  summary: string;
  /** stored upload; loaded with the auth header and shown as a blob: URL */
  imageId: string | null;
  /** legacy cards that carry an image URL directly */
  imageSrc: string;
  /** width / height of the image */
  aspect: number;
  annotations: Annotation[];
  route: Route | null;
}

const clampAspect = (value: number) => Math.min(20, Math.max(0.05, value));

export function parseAnnotatorData(data: Record<string, unknown>): AnnotatorData {
  const rawId = asText(data.image_id ?? data.imageId);
  const imageId = IMAGE_ID_RE.test(rawId) ? rawId : null;
  const width = Number(data.width);
  const height = Number(data.height);
  const ratio = Number(data.aspectRatio);
  const aspect = width > 0 && height > 0 && Number.isFinite(width / height)
    ? clampAspect(width / height)
    : Number.isFinite(ratio) && ratio > 0 ? clampAspect(ratio) : 4 / 3;

  const items: Array<{ annotation: Annotation; target: string }> = [];
  for (const entry of asList(data.annotations)) {
    if (items.length >= MAX_ANNOTATIONS) break;
    const item = asRecord(entry);
    const box = parseBox(item.bbox ?? item.box_2d ?? item.box);
    if (!box) continue;
    items.push({
      annotation: {
        id: asText(item.id).trim().slice(0, 16) || `a${items.length + 1}`,
        box,
        shape: item.shape === "rect" ? "rect" : "ellipse",
        text: (asText(item.note) || asText(item.label) || "批注").slice(0, 300),
        color: safeColor(item.color),
        arrowTo: null,
      },
      target: asText(item.arrow_to ?? item.arrowTo).trim(),
    });
  }
  const annotations = items.map((item) => item.annotation);
  items.forEach(({ annotation, target }, index) => {
    const to = target ? annotations.findIndex((other) => other.id === target) : -1;
    annotation.arrowTo = to >= 0 && to !== index ? to : null;
  });
  return {
    title: asText(data.title, "图片批注").slice(0, 80) || "图片批注",
    summary: asText(data.summary).trim().slice(0, 400),
    imageId,
    imageSrc: imageId ? "" : safeImageSrc(data.imageUrl ?? data.src ?? data.image),
    aspect,
    annotations,
    route: parseRoute(data.route),
  };
}

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Outline around a box, in a viewBox of width 1000 and height `viewHeight` (keeps circles round). */
export function ellipseOf(box: Box, viewHeight: number): Ellipse {
  const sy = viewHeight / 1000;
  const [ymin, xmin, ymax, xmax] = box;
  return {
    cx: (xmin + xmax) / 2,
    cy: ((ymin + ymax) / 2) * sy,
    rx: Math.max(((xmax - xmin) / 2) * 1.08, 12),
    ry: Math.max(((ymax - ymin) / 2) * sy * 1.08, 12),
  };
}

function edgePoint(shape: Ellipse, towardX: number, towardY: number): [number, number] | null {
  const dx = towardX - shape.cx;
  const dy = towardY - shape.cy;
  const k = Math.sqrt((dx / shape.rx) ** 2 + (dy / shape.ry) ** 2);
  return k === 0 ? null : [shape.cx + dx / k, shape.cy + dy / k];
}

export interface Arrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** polygon points of the arrowhead */
  head: string;
}

/** Arrow from one outline's edge to the other's. Null when the outlines overlap. */
export function arrowBetween(from: Ellipse, to: Ellipse, headLength = 16): Arrow | null {
  const start = edgePoint(from, to.cx, to.cy);
  const end = edgePoint(to, from.cx, from.cy);
  if (!start || !end) return null;
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const length = Math.hypot(vx, vy);
  // Overlapping outlines make the edge points cross over, so the arrow would point backwards.
  if (length < headLength * 1.5 || vx * (to.cx - from.cx) + vy * (to.cy - from.cy) <= 0) return null;
  const ux = vx / length;
  const uy = vy / length;
  const bx = end[0] - ux * headLength;
  const by = end[1] - uy * headLength;
  const half = headLength * 0.45;
  const head = [[end[0], end[1]], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]]
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return { x1: start[0], y1: start[1], x2: bx, y2: by, head };
}

// ---------------------------------------------------------------- circuit_netlist

export const ELEMENT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["R", "电阻"], ["L", "电感"], ["C", "电容"], ["V", "电压源"], ["I", "电流源"],
  ["VCVS", "压控电压源"], ["VCCS", "压控电流源"], ["CCVS", "流控电压源"], ["CCCS", "流控电流源"],
  ["SW", "开关"], ["W", "导线"], ["OTHER", "其他"],
];
const ELEMENT_CODES = new Set(ELEMENT_OPTIONS.map(([code]) => code));
export const CONTROLLED_ELEMENTS = new Set(["VCVS", "VCCS", "CCVS", "CCCS"]);
const ELEMENT_ALIASES: Record<string, string> = {
  电阻: "R", RESISTOR: "R", 电感: "L", INDUCTOR: "L", 电容: "C", CAPACITOR: "C",
  电压源: "V", 电池: "V", BATTERY: "V", 电流源: "I", 开关: "SW", SWITCH: "SW", 导线: "W", WIRE: "W",
};

export function elementLabel(code: string): string {
  return ELEMENT_OPTIONS.find(([value]) => value === code)?.[1] ?? code;
}

export interface NetControl {
  ref: string;
  quantity: "U" | "I" | "";
  direction: string;
}

export interface NetBranch {
  id: string;
  element: string;
  value: string;
  from: string;
  to: string;
  polarity: string;
  control: NetControl | null;
}

export interface NetNode {
  id: string;
  note: string;
}

export interface NetIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  ref: string | null;
}

export interface NetlistData {
  title: string;
  netlistId: string | null;
  version: number;
  imageId: string | null;
  /** public/legacy image URL when there is no stored upload id */
  imageSrc: string;
  confirmed: boolean;
  nodes: NetNode[];
  branches: NetBranch[];
  uncertain: string[];
  issues: NetIssue[];
  route: Route | null;
}

function normalizeElement(raw: string): { element: string; leftover: string } {
  const trimmed = raw.trim();
  const key = trimmed.toUpperCase().replace(/[\s_-]/g, "");
  if (ELEMENT_CODES.has(key)) return { element: key, leftover: "" };
  const alias = ELEMENT_ALIASES[trimmed] ?? ELEMENT_ALIASES[key];
  return alias ? { element: alias, leftover: "" } : { element: "OTHER", leftover: trimmed };
}

export function parseIssues(raw: unknown): NetIssue[] {
  return asList(raw).flatMap((entry) => {
    const item = asRecord(entry);
    const message = asText(item.message).slice(0, 200);
    if (!message) return [];
    return [{
      level: item.level === "error" ? "error" : "warning",
      code: asText(item.code),
      message,
      ref: asText(item.ref) || null,
    } as NetIssue];
  });
}

const ident = (value: unknown) => asText(value).trim().slice(0, 16);

export function parseNetlistData(data: Record<string, unknown>): NetlistData {
  const nodes: NetNode[] = [];
  const seen = new Set<string>();
  const addNode = (id: string, note = "") => {
    if (id && !seen.has(id)) {
      seen.add(id);
      nodes.push({ id, note });
    }
  };
  for (const raw of asList(data.nodes)) {
    if (typeof raw === "string" || typeof raw === "number") addNode(ident(raw));
    else {
      const item = asRecord(raw);
      addNode(ident(item.id ?? item.label), asText(item.note).slice(0, 60));
    }
  }
  const branches: NetBranch[] = [];
  asList(data.branches).slice(0, MAX_BRANCHES).forEach((raw, index) => {
    const item = asRecord(raw);
    const ends = asList(item.nodes);
    const from = ident(item.from ?? ends[0]);
    const to = ident(item.to ?? ends[1]);
    const { element, leftover } = normalizeElement(asText(item.element ?? item.type ?? item.component));
    const control = asRecord(item.control);
    const ref = ident(control.ref ?? control.branch);
    const quantity = asText(control.quantity).toUpperCase();
    branches.push({
      id: ident(item.id ?? item.name) || `B${index + 1}`,
      element,
      value: (asText(item.value) || leftover).slice(0, 40),
      from,
      to,
      polarity: asText(item.polarity ?? item.direction).slice(0, 24),
      control: ref
        ? { ref, quantity: quantity === "I" ? "I" : quantity === "U" || quantity === "V" ? "U" : "",
            direction: asText(control.direction).slice(0, 24) }
        : null,
    });
    addNode(from);
    addNode(to);
  });
  const rawNetlistId = asText(data.netlist_id ?? data.netlistId);
  const rawImageId = asText(data.image_id ?? data.imageId);
  const version = Number(data.version);
  return {
    title: asText(data.title, "电路拓扑确认").slice(0, 80) || "电路拓扑确认",
    netlistId: NETLIST_ID_RE.test(rawNetlistId) ? rawNetlistId : null,
    version: Number.isInteger(version) && version >= 1 ? version : 1,
    imageId: IMAGE_ID_RE.test(rawImageId) ? rawImageId : null,
    imageSrc: IMAGE_ID_RE.test(rawImageId) ? "" : safeImageSrc(data.imageUrl ?? data.src ?? data.image),
    confirmed: data.confirmed === true,
    nodes,
    branches,
    uncertain: asList(data.uncertain).map(ident).filter((id) => branches.some((branch) => branch.id === id)),
    issues: parseIssues(data.issues),
    route: parseRoute(data.route),
  };
}

/** Errors that block confirmation. The backend re-checks everything and adds warnings. */
export function checkNetlist(branches: NetBranch[]): NetIssue[] {
  const issues: NetIssue[] = [];
  const error = (code: string, message: string, ref: string | null) => issues.push({ level: "error", code, message, ref });
  const all = new Set(branches.map((branch) => branch.id));
  const seen = new Set<string>();
  if (branches.length === 0) error("empty", "至少需要一条支路。", null);
  for (const branch of branches) {
    if (!branch.id) error("missing_id", "有支路没有填写编号。", null);
    else if (seen.has(branch.id)) error("duplicate_branch", `支路编号 ${branch.id} 重复。`, branch.id);
    seen.add(branch.id);
    const name = branch.id || "?";
    if (!branch.from || !branch.to) error("missing_end", `支路 ${name} 缺少起点或终点。`, branch.id || null);
    else if (branch.from === branch.to) error("self_loop", `支路 ${name} 两端接在同一节点 ${branch.to}。`, branch.id || null);
    if (CONTROLLED_ELEMENTS.has(branch.element)) {
      const ref = branch.control?.ref ?? "";
      if (!ref || ref === branch.id || !all.has(ref)) {
        error("missing_control", `受控源 ${name} 需要选择控制量所在的支路。`, branch.id || null);
      } else if (!branch.control?.quantity) {
        error("missing_control", `受控源 ${name} 需要选择控制量类型。`, branch.id || null);
      } else {
        const expected = branch.element.startsWith("V") ? "U" : "I";
        if (branch.control.quantity !== expected) {
          error("bad_control_quantity", `受控源 ${name} 应使用${expected === "U" ? "电压" : "电流"}控制量。`, branch.id || null);
        }
      }
    }
  }
  return issues;
}

/** Wire shape accepted by POST /api/vision/netlists/{id}/confirm. Unreferenced nodes are dropped. */
export function toWireNetlist(nodes: NetNode[], branches: NetBranch[]) {
  const used = new Set(branches.flatMap((branch) => [branch.from, branch.to]).filter(Boolean));
  const notes = new Map(nodes.map((node) => [node.id, node.note]));
  const ids = [...nodes.map((node) => node.id).filter((id) => used.has(id)), ...[...used].filter((id) => !notes.has(id))];
  return {
    nodes: ids.map((id) => ({ id, note: notes.get(id) ?? "" })),
    branches: branches.map((branch) => ({
      id: branch.id, element: branch.element, value: branch.value, from: branch.from, to: branch.to,
      polarity: branch.polarity,
      control: CONTROLLED_ELEMENTS.has(branch.element) && branch.control
        ? { ref: branch.control.ref, quantity: branch.control.quantity || null, direction: branch.control.direction }
        : null,
    })),
    // The student has reviewed every branch, so nothing stays "uncertain".
    uncertain: [] as string[],
  };
}

export function describeControl(control: NetControl | null): string {
  if (!control) return "";
  const quantity = control.quantity === "U" ? "电压" : control.quantity === "I" ? "电流" : "控制量";
  return `受 ${control.ref} 的${quantity}控制${control.direction ? `（${control.direction}）` : ""}`;
}

/** Plain-text netlist for prompts when a card has no stored id (model-written legacy cards). */
export function netlistText(nodes: NetNode[], branches: NetBranch[]): string {
  const nodeIds = nodes.length ? nodes.map((node) => node.id) : [...new Set(branches.flatMap((b) => [b.from, b.to]))];
  return [
    `节点：${nodeIds.join("、") || "（未列出）"}`,
    ...branches.map((branch) => {
      const parts = [`${branch.id}：${elementLabel(branch.element)}${branch.value ? ` ${branch.value}` : ""}，${branch.from || "?"} → ${branch.to || "?"}`];
      if (branch.polarity) parts.push(`极性/参考方向 ${branch.polarity}`);
      if (CONTROLLED_ELEMENTS.has(branch.element) && branch.control) parts.push(describeControl(branch.control));
      return parts.join("，");
    }),
  ].join("\n");
}

// ---------------------------------------------------------------- message markers

// Must match the id patterns in backend/app/vision/store.py.
// No shared /g regex: .test() would leave lastIndex behind, and matchAll() copies lastIndex,
// so a later split would silently skip the first marker.
const MARKER_SOURCE = String.raw`\[\[kg-image:(img_[A-Za-z0-9_-]{16,40})\]\]|\[\[kg-netlist:(net_[A-Za-z0-9_-]{16,40})@(\d{1,4})\]\]`;
const MARKER_TEST_RE = new RegExp(MARKER_SOURCE);

export type MarkerSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; imageId: string }
  | { kind: "netlist"; netlistId: string; version: number };

export const imageMarker = (imageId: string) => `[[kg-image:${imageId}]]`;

/** Puts the marker on its own line at the end of the draft, keeping what the student already typed. */
export function withImageMarker(draft: string, marker: string): string {
  const body = draft.replace(/\s+$/, "");
  return body ? `${body}\n${marker}\n` : `${marker}\n`;
}

export function hasVisionMarker(text: string): boolean {
  return MARKER_TEST_RE.test(text);
}

export function splitVisionMarkers(text: string): MarkerSegment[] {
  const segments: MarkerSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(MARKER_SOURCE, "g"))) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    segments.push(match[1]
      ? { kind: "image", imageId: match[1] }
      : { kind: "netlist", netlistId: match[2], version: Number(match[3]) });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}
