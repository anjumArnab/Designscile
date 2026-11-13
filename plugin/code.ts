// Designsicle — plugin sandbox.
//
// Owns the live node tree: selection, design properties, extraction, pruning.
// Has NO network access (WebSocket lives in ui.html) and NO filesystem access.
// Talks to the iframe over postMessage only.

// Tunable heuristics
//
// Layer-naming conventions differ per team. These are the knobs to turn when
// Designsicle misreads a file; they are deliberately kept together at the top.

const IMAGE_NAME_PATTERN = /image|photo|avatar|thumbnail|cover|picture/i;
const ICON_NAME_PATTERN = /icon|ic_/i;
const ICON_MAX_DIMENSION = 48;

// The doc's collapse rule lists fill/border/radius/shadow only. Padding is
// added here because collapsing a padded wrapper silently drops real spacing
// and the agent then generates a flush-edge component. Set to false for more
// aggressive (but lossy) pruning.
const COLLAPSE_REQUIRES_NO_PADDING = true;

const MAX_TEXT_CHARS = 80;
const INDENT = "  ";

// Slack when deciding whether two absolutely-positioned boxes overlap. Designs
// routinely land a pixel off, and a 1px kiss should not defeat flow detection.
const OVERLAP_TOLERANCE = 0.5;

const UI_WIDTH = 420;
const UI_HEIGHT = 720;

// JPEG render of the selection, so the agent can see the component as well as
// read its numbers. 2x keeps small components legible; the cap stops a large
// board from producing a multi-megabyte payload.
const IMAGE_EXPORT_SCALE = 2;
const IMAGE_MAX_DIMENSION = 2048;

// Asset export (download_assets): icons ship as SVG, images as PNG. The caps
// keep one call from producing a payload that stalls the relay; everything
// skipped is reported with its node id so the agent can fetch it explicitly.
const ASSET_EXPORT_SCALE = 2;
const ASSET_MAX_DIMENSION = 2048;
const MAX_ASSETS = 64;
const MAX_REQUESTED_ASSETS = 32;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 6 * 1024 * 1024;

const MAIN_AXIS_ALIGN: { [key: string]: string } = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between"
};

const CROSS_AXIS_ALIGN: { [key: string]: string } = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  BASELINE: "baseline"
};

// Type narrowing
//
// figma.mixed is a unique symbol, and the properties we read live on different
// mixins. Everything below routes through these guards; an unnarrowed mixed
// value renders as NaN in the output, which is worse than omitting it.

type MaybeMixed<T> = T | PluginAPI["mixed"];

function isDefined<T>(value: MaybeMixed<T>): value is T {
  return value !== figma.mixed;
}

type WithFills = { fills: MaybeMixed<readonly Paint[]> };
type WithStrokes = { strokes: readonly Paint[] };
type WithStrokeWeight = { strokeWeight: MaybeMixed<number> };
type WithCorners = { cornerRadius: MaybeMixed<number> };
type WithRectangleCorners = {
  topLeftRadius: number;
  topRightRadius: number;
  bottomRightRadius: number;
  bottomLeftRadius: number;
};
type WithEffects = { effects: readonly Effect[] };
type WithChildren = { children: readonly SceneNode[] };
type WithSize = { width: number; height: number };
type WithRotation = { rotation: number };
type WithAutoLayout = {
  layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL";
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  itemSpacing: number;
  primaryAxisAlignItems: string;
  counterAxisAlignItems: string;
};

function hasFills(node: SceneNode): node is SceneNode & WithFills {
  return "fills" in node;
}

function hasStrokes(node: SceneNode): node is SceneNode & WithStrokes {
  return "strokes" in node;
}

function hasStrokeWeight(node: SceneNode): node is SceneNode & WithStrokeWeight {
  return "strokeWeight" in node;
}

function hasCorners(node: SceneNode): node is SceneNode & WithCorners {
  return "cornerRadius" in node;
}

// Separate guard: per-corner values come from RectangleCornerMixin and are only
// reachable once cornerRadius has been found to be mixed.
function hasRectangleCorners(node: SceneNode): node is SceneNode & WithRectangleCorners {
  return "topLeftRadius" in node;
}

function hasEffects(node: SceneNode): node is SceneNode & WithEffects {
  return "effects" in node;
}

function hasChildren(node: SceneNode): node is SceneNode & WithChildren {
  return "children" in node;
}

function hasSize(node: SceneNode): node is SceneNode & WithSize {
  return "width" in node && "height" in node;
}

function hasRotation(node: SceneNode): node is SceneNode & WithRotation {
  return "rotation" in node;
}

function isAutoLayout(node: SceneNode): node is SceneNode & WithAutoLayout {
  return "layoutMode" in node;
}

// Auto layout actually driving the children, as opposed to a frame that merely
// carries the properties with layoutMode NONE.
function isFlexContainer(node: SceneNode): node is SceneNode & WithAutoLayout {
  return isAutoLayout(node) && node.layoutMode !== "NONE";
}

// absoluteBoundingBox is the one coordinate space that behaves the same for
// frames and groups; child.x is frame-relative but group-relative children are
// not, so deriving offsets from x/y alone would be wrong half the time.
function boundsOf(node: SceneNode): Rect | null {
  if (!("absoluteBoundingBox" in node)) {
    return null;
  }
  return (node as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
}

function isVisible(node: SceneNode): boolean {
  if ("visible" in node && node.visible === false) {
    return false;
  }
  if ("opacity" in node && node.opacity === 0) {
    return false;
  }
  return true;
}

function visibleChildren(node: SceneNode): readonly SceneNode[] {
  if (!hasChildren(node)) {
    return [];
  }
  return node.children.filter(isVisible);
}

// Design tokens
//
// Emitting the variable name instead of the raw value is what makes output land
// in the team's design system rather than as magic numbers. Raw value is the
// fallback, never the preference.

const variableNameCache = new Map<string, string | null>();

type BoundVariables = { [key: string]: VariableAlias | readonly VariableAlias[] | undefined };

function boundVariablesOf(node: SceneNode): BoundVariables | null {
  const bound = (node as SceneNode & { boundVariables?: unknown }).boundVariables;
  if (bound === undefined || bound === null || typeof bound !== "object") {
    return null;
  }
  return bound as BoundVariables;
}

async function resolveVariableName(id: string): Promise<string | null> {
  const cached = variableNameCache.get(id);
  if (cached !== undefined) {
    return cached;
  }
  let name: string | null = null;
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    name = variable === null ? null : variable.name;
  } catch (_error) {
    name = null;
  }
  variableNameCache.set(id, name);
  return name;
}

// Returns the bound variable's name for a property, or null when the property
// carries a raw value.
async function boundVariableName(node: SceneNode, field: string): Promise<string | null> {
  const bound = boundVariablesOf(node);
  if (bound === null) {
    return null;
  }
  const entry = bound[field];
  if (entry === undefined || entry === null) {
    return null;
  }
  const alias = Array.isArray(entry) ? (entry as VariableAlias[])[0] : (entry as VariableAlias);
  if (alias === undefined || typeof alias.id !== "string") {
    return null;
  }
  return resolveVariableName(alias.id);
}

// A measurement is either a token name or a rounded number.
async function measurement(node: SceneNode, field: string, raw: number): Promise<string> {
  const name = await boundVariableName(node, field);
  return name === null ? num(raw) : name;
}

// Formatting primitives

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function channel(value: number): string {
  const hex = Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).toUpperCase();
  return hex.length === 1 ? "0" + hex : hex;
}

function rgbToHex(color: RGB): string {
  return "#" + channel(color.r) + channel(color.g) + channel(color.b);
}

function withAlpha(hex: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1) {
    return hex;
  }
  return hex + " " + num(alpha * 100) + "%";
}

function rgbaToHex(color: RGBA): string {
  return withAlpha(rgbToHex(color), color.a);
}

function firstVisiblePaint(paints: readonly Paint[]): Paint | null {
  for (const paint of paints) {
    if (paint.visible === false) {
      continue;
    }
    return paint;
  }
  return null;
}

function paintToColor(paint: Paint): string | null {
  if (paint.type === "SOLID") {
    return withAlpha(rgbToHex(paint.color), paint.opacity);
  }
  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    return "gradient";
  }
  return null;
}

// Resolves a node's paint colour, preferring a bound variable over the raw hex.
async function colorOf(node: SceneNode, field: "fills" | "strokes"): Promise<string | null> {
  const name = await boundVariableName(node, field);
  if (name !== null) {
    return name;
  }
  let paints: readonly Paint[];
  if (field === "fills") {
    if (!hasFills(node)) {
      return null;
    }
    const fills = node.fills;
    // Mixed fills mean per-character or per-region colour; omitting is better
    // than emitting a value that is wrong everywhere but one place.
    if (!isDefined(fills)) {
      return null;
    }
    paints = fills;
  } else {
    if (!hasStrokes(node)) {
      return null;
    }
    paints = node.strokes;
  }
  const paint = firstVisiblePaint(paints);
  return paint === null ? null : paintToColor(paint);
}

function formatCharacters(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const clipped =
    collapsed.length > MAX_TEXT_CHARS ? collapsed.slice(0, MAX_TEXT_CHARS - 1) + "…" : collapsed;
  return clipped.replace(/"/g, '\\"');
}

// Property descriptors
//
// Every one of these returns null for a Figma default. Pruning is the product:
// only properties that change generated code get emitted.

async function backgroundDescriptor(node: SceneNode): Promise<string | null> {
  const color = await colorOf(node, "fills");
  return color === null ? null : "bg " + color;
}

async function radiusDescriptor(node: SceneNode): Promise<string | null> {
  if (!hasCorners(node)) {
    return null;
  }
  const radius = node.cornerRadius;
  if (isDefined(radius)) {
    // A uniform radius binds all four corner fields to the same variable.
    const token = await boundVariableName(node, "topLeftRadius");
    if (token !== null) {
      return "radius " + token;
    }
    return radius > 0 ? "radius " + num(radius) : null;
  }
  if (!hasRectangleCorners(node)) {
    return null;
  }
  const corners = await Promise.all([
    measurement(node, "topLeftRadius", node.topLeftRadius),
    measurement(node, "topRightRadius", node.topRightRadius),
    measurement(node, "bottomRightRadius", node.bottomRightRadius),
    measurement(node, "bottomLeftRadius", node.bottomLeftRadius)
  ]);
  if (
    node.topLeftRadius === 0 &&
    node.topRightRadius === 0 &&
    node.bottomRightRadius === 0 &&
    node.bottomLeftRadius === 0
  ) {
    return null;
  }
  if (corners[0] === corners[1] && corners[1] === corners[2] && corners[2] === corners[3]) {
    return "radius " + corners[0];
  }
  return "radius " + corners.join("/");
}

async function borderDescriptor(node: SceneNode): Promise<string | null> {
  if (!hasStrokes(node) || node.strokes.length === 0) {
    return null;
  }
  const color = await colorOf(node, "strokes");
  if (color === null) {
    return null;
  }
  let weight = "1";
  if (hasStrokeWeight(node)) {
    const raw = node.strokeWeight;
    if (isDefined(raw)) {
      if (raw === 0) {
        return null;
      }
      weight = await measurement(node, "strokeWeight", raw);
    }
  }
  return "border " + weight + "px solid " + color;
}

function shadowDescriptor(node: SceneNode): string | null {
  if (!hasEffects(node)) {
    return null;
  }
  for (const effect of node.effects) {
    if (effect.visible === false) {
      continue;
    }
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const prefix = effect.type === "INNER_SHADOW" ? "inner-shadow " : "shadow ";
      return (
        prefix +
        num(effect.offset.x) +
        "/" +
        num(effect.offset.y) +
        " blur " +
        num(effect.radius) +
        " " +
        rgbaToHex(effect.color)
      );
    }
  }
  return null;
}

// all-equal -> "padding 16"; vertical/horizontal pairs -> "padding 12/16";
// otherwise "padding t/r/b/l".
function compressPadding(top: string, right: string, bottom: string, left: string): string {
  if (top === right && right === bottom && bottom === left) {
    return "padding " + top;
  }
  if (top === bottom && left === right) {
    return "padding " + top + "/" + right;
  }
  return "padding " + top + "/" + right + "/" + bottom + "/" + left;
}

interface PlacedChild {
  node: SceneNode;
  bounds: Rect;
}

interface StackPlan {
  direction: "Stack" | "Column" | "Row";
  padding: string | null;
  // Children in VISUAL order. Figma's child array is z-order, which for an
  // absolutely-positioned frame routinely puts a full-bleed image last even
  // though it renders at the top — emitting that order builds the card upside
  // down.
  order: readonly SceneNode[];
  // Parallel to `order`.
  suffixes: readonly (string | null)[];
  // Absolute children need their own box stated; flowed ones do not.
  childrenNeedBox: boolean;
}

// Two boxes overlap along an axis if their spans intersect.
function overlaps(a: Rect, b: Rect, axis: "x" | "y"): boolean {
  const aStart = axis === "x" ? a.x : a.y;
  const bStart = axis === "x" ? b.x : b.y;
  const aEnd = aStart + (axis === "x" ? a.width : a.height);
  const bEnd = bStart + (axis === "x" ? b.width : b.height);
  return aStart < bEnd - OVERLAP_TOLERANCE && bStart < aEnd - OVERLAP_TOLERANCE;
}

// A flow exists along `axis` when, in that order, no two neighbours overlap
// along it AND every neighbouring pair overlaps on the cross axis — that second
// half is what separates a real column from items scattered diagonally.
function flowsAlong(sorted: readonly PlacedChild[], axis: "x" | "y"): boolean {
  const cross = axis === "x" ? "y" : "x";
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1].bounds;
    const current = sorted[i].bounds;
    if (overlaps(previous, current, axis)) {
      return false;
    }
    if (!overlaps(previous, current, cross)) {
      return false;
    }
  }
  return true;
}

// Absolutely-positioned containers have no applied layout, but the geometry
// still carries the intent. Two things are recovered here:
//
//   1. Padding — children uniformly inset from every edge of their parent ARE
//      padding, whatever Figma's stale fields say. Only a SYMMETRIC inset is
//      read that way; when the edges disagree the numbers describe where things
//      happen to sit, and calling that "padding" puts words in the designer's
//      mouth.
//   2. Direction — children that queue up along one axis without overlapping,
//      while sharing space on the other, are a Column or a Row. Saying so lets
//      the spec carry per-child gaps instead of raw coordinates, which is what
//      an agent actually needs to generate layout code.
//
// Everything else stays an honest Stack.
function planStack(node: SceneNode, children: readonly SceneNode[]): StackPlan | null {
  const outer = boundsOf(node);
  if (outer === null || children.length === 0) {
    return null;
  }

  const placed: PlacedChild[] = [];
  for (const child of children) {
    const bounds = boundsOf(child);
    if (bounds === null) {
      return null;
    }
    placed.push({ node: child, bounds: bounds });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entry of placed) {
    minX = Math.min(minX, entry.bounds.x);
    minY = Math.min(minY, entry.bounds.y);
    maxX = Math.max(maxX, entry.bounds.x + entry.bounds.width);
    maxY = Math.max(maxY, entry.bounds.y + entry.bounds.height);
  }

  // Sub-pixel offsets are measurement noise, not design intent.
  const top = Math.round(minY - outer.y);
  const left = Math.round(minX - outer.x);
  const right = Math.round(outer.x + outer.width - maxX);
  const bottom = Math.round(outer.y + outer.height - maxY);

  let padding: string | null = null;
  let originX = outer.x;
  let originY = outer.y;
  const inside = top >= 0 && right >= 0 && bottom >= 0 && left >= 0;
  const inset = top !== 0 || right !== 0 || bottom !== 0 || left !== 0;
  if (inside && inset && top === bottom && left === right) {
    padding = compressPadding(String(top), String(right), String(bottom), String(left));
    // Offsets now measure from the content box, so padding and position can
    // never be double-counted.
    originX = minX;
    originY = minY;
  }

  const byY = placed.slice().sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const byX = placed.slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const isColumn = placed.length > 1 && flowsAlong(byY, "y");
  const isRow = placed.length > 1 && flowsAlong(byX, "x");

  // Ambiguous both ways means neither reading is safe.
  if (isColumn && !isRow) {
    return flowPlan(byY, "Column", padding, originX, originY);
  }
  if (isRow && !isColumn) {
    return flowPlan(byX, "Row", padding, originX, originY);
  }

  const suffixes = placed.map((entry) => {
    // A lone child inside stated padding is at 0,0 by construction.
    if (placed.length === 1 && padding !== null) {
      return null;
    }
    return (
      "at " +
      String(Math.round(entry.bounds.x - originX)) +
      "," +
      String(Math.round(entry.bounds.y - originY))
    );
  });
  return { direction: "Stack", padding, order: children, suffixes, childrenNeedBox: true };
}

// Re-expresses absolute positions as flow: each child carries the gap above (or
// before) it and its cross-axis inset. "gap 16" is a SizedBox; "at 24" is an
// indent. Both are things a developer writes; a y-coordinate is not.
function flowPlan(
  sorted: readonly PlacedChild[],
  direction: "Column" | "Row",
  padding: string | null,
  originX: number,
  originY: number
): StackPlan {
  const vertical = direction === "Column";
  const order: SceneNode[] = [];
  const suffixes: (string | null)[] = [];
  let cursor = vertical ? originY : originX;

  for (const entry of sorted) {
    const start = vertical ? entry.bounds.y : entry.bounds.x;
    const extent = vertical ? entry.bounds.height : entry.bounds.width;
    const crossInset = Math.round(
      (vertical ? entry.bounds.x : entry.bounds.y) - (vertical ? originX : originY)
    );
    const gap = Math.round(start - cursor);

    const parts: string[] = [];
    if (crossInset !== 0) {
      parts.push("at " + String(crossInset));
    }
    if (gap !== 0) {
      parts.push("gap " + String(gap));
    }

    order.push(entry.node);
    suffixes.push(parts.length === 0 ? null : parts.join(", "));
    cursor = start + extent;
  }

  return { direction, padding, order, suffixes, childrenNeedBox: false };
}

async function paddingDescriptor(node: SceneNode): Promise<string | null> {
  // Figma retains padding values after auto-layout is removed but stops
  // applying them. Emitting those would invent spacing the design does not have.
  if (!isFlexContainer(node)) {
    return null;
  }
  if (
    node.paddingTop === 0 &&
    node.paddingRight === 0 &&
    node.paddingBottom === 0 &&
    node.paddingLeft === 0
  ) {
    return null;
  }
  const sides = await Promise.all([
    measurement(node, "paddingTop", node.paddingTop),
    measurement(node, "paddingRight", node.paddingRight),
    measurement(node, "paddingBottom", node.paddingBottom),
    measurement(node, "paddingLeft", node.paddingLeft)
  ]);
  return compressPadding(sides[0], sides[1], sides[2], sides[3]);
}

async function gapDescriptor(node: SceneNode): Promise<string | null> {
  if (!isFlexContainer(node)) {
    return null;
  }
  // Figma ignores itemSpacing under space-between, so emitting it would be a lie.
  if (node.primaryAxisAlignItems === "SPACE_BETWEEN" || node.itemSpacing === 0) {
    return null;
  }
  return "gap " + (await measurement(node, "itemSpacing", node.itemSpacing));
}

function alignDescriptors(node: SceneNode): string[] {
  if (!isFlexContainer(node)) {
    return [];
  }
  const parts: string[] = [];
  const main = MAIN_AXIS_ALIGN[node.primaryAxisAlignItems];
  if (main !== undefined && node.primaryAxisAlignItems !== "MIN") {
    parts.push("main " + main);
  }
  const cross = CROSS_AXIS_ALIGN[node.counterAxisAlignItems];
  if (cross !== undefined && node.counterAxisAlignItems !== "MIN") {
    parts.push("cross " + cross);
  }
  return parts;
}

function directionOf(node: SceneNode): string {
  if (!isFlexContainer(node)) {
    // Absolutely-positioned children, described by geometry instead.
    return "Stack";
  }
  return node.layoutMode === "HORIZONTAL" ? "Row" : "Column";
}

// Element classification

function isImageElement(node: SceneNode): boolean {
  if (IMAGE_NAME_PATTERN.test(node.name)) {
    return true;
  }
  if (!hasFills(node)) {
    return false;
  }
  const fills = node.fills;
  if (!isDefined(fills)) {
    return false;
  }
  for (const paint of fills) {
    if (paint.visible !== false && paint.type === "IMAGE") {
      return true;
    }
  }
  return false;
}

function isIconElement(node: SceneNode): boolean {
  if (!hasSize(node)) {
    return false;
  }
  if (node.width > ICON_MAX_DIMENSION || node.height > ICON_MAX_DIMENSION) {
    return false;
  }
  return node.type === "VECTOR" || ICON_NAME_PATTERN.test(node.name);
}

function isContainerElement(node: SceneNode): boolean {
  if (visibleChildren(node).length > 0) {
    return true;
  }
  return (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" ||
    node.type === "INSTANCE" ||
    node.type === "RECTANGLE" ||
    node.type === "GROUP"
  );
}

// Line builders

function line(depth: number, body: string): string {
  let indent = "";
  for (let i = 0; i < depth; i++) {
    indent += INDENT;
  }
  return indent + body;
}

async function containerLine(
  node: SceneNode,
  depth: number,
  children: readonly SceneNode[],
  plan: StackPlan | null,
  needsBox: boolean
): Promise<string> {
  const direction = plan === null ? directionOf(node) : plan.direction;
  const parts: string[] = [direction];
  // A box only needs stating when something is positioned against it: a Stack
  // laying children out by raw offset, or this node being one of those
  // children. Flowed children carry gaps, so the parent's box is redundant.
  const positionsChildren = direction === "Stack" && children.length > 1;
  if ((positionsChildren || needsBox) && hasSize(node)) {
    parts.push(num(node.width) + "×" + num(node.height) + " px");
  }
  const descriptors = await Promise.all([
    backgroundDescriptor(node),
    radiusDescriptor(node),
    borderDescriptor(node),
    paddingDescriptor(node),
    gapDescriptor(node)
  ]);
  const background = descriptors[0];
  const radius = descriptors[1];
  const border = descriptors[2];
  const padding = descriptors[3] === null ? (plan === null ? null : plan.padding) : descriptors[3];
  const gap = descriptors[4];
  const shadow = shadowDescriptor(node);
  if (background !== null) parts.push(background);
  if (radius !== null) parts.push(radius);
  if (border !== null) parts.push(border);
  if (shadow !== null) parts.push(shadow);
  if (padding !== null) parts.push(padding);
  if (gap !== null) parts.push(gap);
  for (const align of alignDescriptors(node)) {
    parts.push(align);
  }
  return line(depth, "CONTAINER: " + parts.join(", "));
}

async function textLine(node: TextNode, depth: number, needsBox: boolean): Promise<string> {
  const parts: string[] = ['"' + formatCharacters(node.characters) + '"'];

  const fontName = node.fontName;
  if (isDefined(fontName)) {
    parts.push(fontName.family);
  }

  const fontSize = node.fontSize;
  if (isDefined(fontSize)) {
    const token = await boundVariableName(node, "fontSize");
    parts.push(token === null ? num(fontSize) + "px" : token);
  }

  const fontWeight = node.fontWeight;
  if (isDefined(fontWeight)) {
    const token = await boundVariableName(node, "fontWeight");
    parts.push("weight " + (token === null ? num(fontWeight) : token));
  }

  const color = await colorOf(node, "fills");
  if (color !== null) {
    parts.push(color);
  }

  const lineHeight = node.lineHeight;
  if (isDefined(lineHeight) && lineHeight.unit !== "AUTO") {
    const token = await boundVariableName(node, "lineHeight");
    const value = lineHeight.unit === "PERCENT" ? num(lineHeight.value) + "%" : num(lineHeight.value);
    parts.push("line-height " + (token === null ? value : token));
  }

  const letterSpacing = node.letterSpacing;
  if (isDefined(letterSpacing) && letterSpacing.value !== 0) {
    const token = await boundVariableName(node, "letterSpacing");
    const value =
      letterSpacing.unit === "PERCENT" ? num(letterSpacing.value) + "%" : num(letterSpacing.value);
    parts.push("letter-spacing " + (token === null ? value : token));
  }

  if (node.textAlignHorizontal !== "LEFT") {
    parts.push("align " + node.textAlignHorizontal.toLowerCase());
  }

  // Absolutely positioned text needs its box stated: "align right" at an x
  // offset is meaningless without knowing where the text actually ends.
  if (needsBox && hasSize(node)) {
    parts.push(num(node.width) + "×" + num(node.height) + " px");
  }

  return line(depth, "TEXT: " + parts.join(", "));
}

async function imageLine(node: SceneNode, depth: number): Promise<string> {
  const parts: string[] = [];
  if (hasSize(node)) {
    parts.push(num(node.width) + "×" + num(node.height) + " px");
  }
  const radius = await radiusDescriptor(node);
  if (radius !== null) {
    parts.push(radius);
  }
  const border = await borderDescriptor(node);
  if (border !== null) {
    parts.push(border);
  }
  const shadow = shadowDescriptor(node);
  if (shadow !== null) {
    parts.push(shadow);
  }
  // The id is the handle download_assets uses to export this node's bytes.
  parts.push("id " + node.id);
  return line(depth, "IMAGE: " + parts.join(", "));
}

async function iconLine(node: SceneNode, depth: number): Promise<string> {
  const parts: string[] = [];
  if (hasSize(node)) {
    parts.push(num(node.width) + "×" + num(node.height) + " px");
  }
  const color = await colorOf(node, "fills");
  if (color !== null) {
    parts.push(color);
  }
  // The id is the handle download_assets uses to export this node's bytes.
  parts.push("id " + node.id);
  const label = node.name.trim() === "" ? "icon" : node.name.trim();
  return line(depth, "ICON: " + label + " — " + parts.join(", "));
}

// Traversal

// A wrapper that adds nothing but a level of nesting is pure token waste.
// Figma files are full of them.
async function isCollapsibleWrapper(node: SceneNode): Promise<boolean> {
  const children = visibleChildren(node);
  if (children.length !== 1) {
    return false;
  }
  if (hasRotation(node) && node.rotation !== 0) {
    return false;
  }
  const descriptors = await Promise.all([
    backgroundDescriptor(node),
    radiusDescriptor(node),
    borderDescriptor(node)
  ]);
  for (const descriptor of descriptors) {
    if (descriptor !== null) {
      return false;
    }
  }
  if (shadowDescriptor(node) !== null) {
    return false;
  }
  if (COLLAPSE_REQUIRES_NO_PADDING) {
    if ((await paddingDescriptor(node)) !== null) {
      return false;
    }
    // A stack whose child is inset carries that inset only in its geometry.
    // Collapsing here would throw away the padding derived above.
    const plan = isFlexContainer(node) ? null : planStack(node, children);
    if (plan !== null && plan.padding !== null) {
      return false;
    }
  }
  return true;
}

// `suffix` is appended to the node's own line — used by stacks to position
// their children, and carried through wrapper collapses so it is never lost.
async function extractNode(
  node: SceneNode,
  depth: number,
  isRoot: boolean,
  suffix: string | null,
  needsBox: boolean
): Promise<string[]> {
  if (!isVisible(node)) {
    return [];
  }

  const withSuffix = (lines: string[]): string[] => {
    if (suffix !== null && lines.length > 0) {
      lines[0] = lines[0] + ", " + suffix;
    }
    return lines;
  };

  if (node.type === "TEXT") {
    return withSuffix([await textLine(node, depth, needsBox)]);
  }

  // Images and icons are leaves — never descend into them.
  if (isImageElement(node)) {
    return withSuffix([await imageLine(node, depth)]);
  }
  if (isIconElement(node)) {
    return withSuffix([await iconLine(node, depth)]);
  }

  if (!isContainerElement(node)) {
    return [];
  }

  const children = visibleChildren(node);

  if (!isRoot && (await isCollapsibleWrapper(node))) {
    return extractNode(children[0], depth, false, suffix, needsBox);
  }

  const plan = isFlexContainer(node) ? null : planStack(node, children);
  const lines = withSuffix([await containerLine(node, depth, children, plan, needsBox)]);

  // Walk in the plan's order — visual, not z-order — so the generated widget
  // tree matches what the designer actually drew.
  const order = plan === null ? children : plan.order;
  for (let i = 0; i < order.length; i++) {
    const childSuffix = plan === null ? null : plan.suffixes[i];
    const childNeedsBox = plan === null ? false : plan.childrenNeedBox;
    const childLines = await extractNode(order[i], depth + 1, false, childSuffix, childNeedsBox);
    for (const childLine of childLines) {
      lines.push(childLine);
    }
  }
  return lines;
}

async function buildSpecForRoot(root: BaseNode): Promise<string> {
  // Cleared per build so a renamed variable is reflected immediately.
  variableNameCache.clear();
  // A page link means "the whole page": every visible top-level node gets its
  // own spec, headed by its name so the agent can tell the sections apart.
  // Header lines start with #, which no other spec line can start with.
  if (root.type === "PAGE") {
    const sections: string[] = [];
    for (const child of root.children) {
      if (!isVisible(child)) {
        continue;
      }
      const lines = await extractNode(child, 0, true, null, false);
      if (lines.length === 0) {
        continue;
      }
      const name = child.name.trim() === "" ? "Unnamed frame" : child.name.trim();
      sections.push("# " + name + "\n" + lines.join("\n"));
    }
    return sections.join("\n\n");
  }
  return (await extractNode(root as SceneNode, 0, true, null, false)).join("\n");
}

// Messaging

interface SpecPayload {
  ok: boolean;
  error: string | null;
  componentName: string | null;
  spec: string | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Links
//
// "Copy link to selection" (or "Copy link to page") yields
//   https://www.figma.com/design/<fileKey>/<name>?node-id=12-34&t=…
// The URL writes dashes where the plugin API uses colons, and older links
// percent-encode the colon instead. Only the file currently open in Figma can
// be read — the plugin API has no REST access — so a foreign file becomes an
// error the agent can act on.

interface ParsedLink {
  fileKey: string | null;
  nodeId: string | null;
}

function normalizeNodeIdParam(raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch (_error) {
    // Keep the raw value; a stray % just fails the format check below.
  }
  value = value.replace(/-/g, ":");
  return /^\d+:\d+$/.test(value) ? value : null;
}

function parseFigmaLink(raw: string): ParsedLink | null {
  const trimmed = raw.trim();
  const fileMatch = /^https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board)\/([^/?#]+)/i.exec(
    trimmed
  );
  const nodeMatch = /[?&]node-id=([^&#]+)/i.exec(trimmed);
  const pageMatch = /[?&]page-id=([^&#]+)/i.exec(trimmed);
  if (fileMatch === null && nodeMatch === null && pageMatch === null) {
    return null;
  }
  let nodeId: string | null = null;
  if (nodeMatch !== null) {
    nodeId = normalizeNodeIdParam(nodeMatch[1]);
  }
  if (nodeId === null && pageMatch !== null) {
    nodeId = normalizeNodeIdParam(pageMatch[1]);
  }
  return { fileKey: fileMatch === null ? null : fileMatch[1], nodeId: nodeId };
}

type RootResolution = { ok: true; root: BaseNode } | { ok: false; error: string };

// figma.fileKey exists only for private plugins; without it the file-key check
// degrades to the not-found error below, which names the likely cause.
function openFileKey(): string | null {
  try {
    const key = figma.fileKey;
    return typeof key === "string" ? key : null;
  } catch (_error) {
    return null;
  }
}

// dynamic-page document access hides other pages until they are loaded, and a
// link may well point at one. Loading is attempted only after a miss, so the
// common same-page link pays nothing.
async function findNodeById(nodeId: string): Promise<BaseNode | null> {
  try {
    const direct = await figma.getNodeByIdAsync(nodeId);
    if (direct !== null) {
      return direct;
    }
    for (const page of figma.root.children) {
      try {
        await page.loadAsync();
      } catch (_error) {
        // The current page is already loaded and may reject a reload.
      }
      if (page.id === nodeId) {
        return page;
      }
    }
    return await figma.getNodeByIdAsync(nodeId);
  } catch (_error) {
    return null;
  }
}

async function resolveLinkRoot(link: string): Promise<RootResolution> {
  const parsed = parseFigmaLink(link);
  if (parsed === null) {
    return {
      ok: false,
      error:
        "Not a recognised Figma file URL. Expected the form " +
        "https://www.figma.com/design/…?node-id=… as produced by 'Copy link to selection'."
    };
  }
  if (parsed.nodeId === null) {
    return {
      ok: false,
      error:
        "The link carries no node id. In Figma, right-click the node (or the page tab) and use " +
        "'Copy link to selection' or 'Copy link to page'."
    };
  }
  const openKey = openFileKey();
  if (parsed.fileKey !== null && openKey !== null && parsed.fileKey !== openKey) {
    return {
      ok: false,
      error:
        "The link points at a different file than the one open in Figma. The plugin can only read " +
        "the open file — ask the user to open the linked file in the Figma desktop app and try again."
    };
  }
  const node = await findNodeById(parsed.nodeId);
  if (node === null) {
    return {
      ok: false,
      error:
        "No node with id " +
        parsed.nodeId +
        " exists in the open file. It may have been deleted, it may sit on a page that could not " +
        "be loaded, or the link may belong to a different file — ask the user to open that file " +
        "in the Figma desktop app and try again."
    };
  }
  if (node.type === "DOCUMENT") {
    return { ok: false, error: "The link points at the document root, which has no spec." };
  }
  return { ok: true, root: node };
}

function selectionRoot(): RootResolution {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return { ok: false, error: "Nothing selected in Figma." };
  }
  return { ok: true, root: selection[0] };
}

async function requestRoot(link: string | null): Promise<RootResolution> {
  if (link !== null && link.trim() !== "") {
    return resolveLinkRoot(link);
  }
  return selectionRoot();
}

// Never throws — the iframe always receives a payload it can render.
async function specPayloadFor(root: BaseNode): Promise<SpecPayload> {
  try {
    const spec = await buildSpecForRoot(root);
    if (spec === "") {
      const what = root.type === "PAGE" ? "page" : "selection";
      return {
        ok: false,
        error:
          "The " +
          what +
          " produced an empty spec. Select or link a frame, component, or text layer.",
        componentName: root.name,
        spec: null
      };
    }
    return { ok: true, error: null, componentName: root.name, spec: spec };
  } catch (error) {
    return {
      ok: false,
      error: "Extraction failed: " + errorMessage(error),
      componentName: root.name,
      spec: null
    };
  }
}

async function requestSpec(link: string | null): Promise<SpecPayload> {
  const resolution = await requestRoot(link);
  if (!resolution.ok) {
    return { ok: false, error: resolution.error, componentName: null, spec: null };
  }
  return specPayloadFor(resolution.root);
}

interface ImagePayload {
  ok: boolean;
  error: string | null;
  componentName: string | null;
  bytes: Uint8Array | null;
}

// Never throws — a failed export must not take the spec down with it.
// Every SceneNode carries exportAsync; pages are the one shape that cannot be
// rendered whole, and a link may point at one.
async function requestImage(link: string | null): Promise<ImagePayload> {
  const resolution = await requestRoot(link);
  if (!resolution.ok) {
    return { ok: false, error: resolution.error, componentName: null, bytes: null };
  }
  if (resolution.root.type === "PAGE") {
    return {
      ok: false,
      error: "A page cannot be rendered as a single image. Link or select a specific frame.",
      componentName: resolution.root.name,
      bytes: null
    };
  }
  const node = resolution.root as SceneNode;
  try {
    let scale = IMAGE_EXPORT_SCALE;
    if (hasSize(node)) {
      const longest = Math.max(node.width, node.height);
      if (longest > 0 && longest * scale > IMAGE_MAX_DIMENSION) {
        scale = Math.max(1, IMAGE_MAX_DIMENSION / longest);
      }
    }
    const bytes = await node.exportAsync({
      format: "JPG",
      constraint: { type: "SCALE", value: scale }
    });
    return { ok: true, error: null, componentName: node.name, bytes: bytes };
  } catch (error) {
    return {
      ok: false,
      error: "Image export failed: " + errorMessage(error),
      componentName: node.name,
      bytes: null
    };
  }
}

// Asset export (download_assets)
//
// Icons ship as SVG — small, recolourable, usable directly as file contents.
// Images ship as PNG because a raster fill has no vector source. Explicitly
// requested nodes may force any format.

type AssetFormat = "SVG" | "PNG" | "JPG";

interface ExportedAsset {
  name: string;
  nodeId: string;
  format: AssetFormat;
  mimeType: string;
  bytes: Uint8Array;
}

interface SkippedAsset {
  nodeId: string;
  reason: string;
  name: string;
}

interface AssetsPayload {
  ok: boolean;
  error: string | null;
  componentName: string | null;
  assets: ExportedAsset[] | null;
  skipped: SkippedAsset[] | null;
}

function mimeTypeFor(format: AssetFormat): string {
  if (format === "SVG") {
    return "image/svg+xml";
  }
  return format === "PNG" ? "image/png" : "image/jpeg";
}

function assetFileExtension(format: AssetFormat): string {
  return format === "SVG" ? "svg" : format === "PNG" ? "png" : "jpg";
}

function assetFileName(name: string): string {
  const cleaned = name.replace(/[^a-z0-9\-_ ]/gi, "").trim();
  return (cleaned === "" ? "asset" : cleaned).replace(/\s+/g, "-").toLowerCase();
}

// Mirrors the spec's classification, so what download_assets returns matches
// what the spec called an ICON or an IMAGE. Text is excluded first, exactly as
// in extractNode — a layer named "photo caption" is text, not an asset.
function inferredAssetFormat(node: SceneNode): AssetFormat {
  if (node.type !== "TEXT" && isImageElement(node)) {
    return "PNG";
  }
  return "SVG";
}

function collectAssetNodes(root: BaseNode): SceneNode[] {
  const found: SceneNode[] = [];
  const visit = (node: SceneNode): void => {
    if (!isVisible(node)) {
      return;
    }
    if (node.type === "TEXT") {
      return;
    }
    if (isImageElement(node) || isIconElement(node)) {
      found.push(node);
      return;
    }
    for (const child of visibleChildren(node)) {
      visit(child);
    }
  };
  if (root.type === "PAGE") {
    for (const child of root.children) {
      visit(child);
    }
    return found;
  }
  visit(root as SceneNode);
  return found;
}

async function exportAssetBytes(node: SceneNode, format: AssetFormat): Promise<Uint8Array> {
  if (format === "SVG") {
    // Outlined text keeps the asset rendering correctly on machines without
    // the design's fonts.
    return node.exportAsync({ format: "SVG" });
  }
  let scale = ASSET_EXPORT_SCALE;
  if (hasSize(node)) {
    const longest = Math.max(node.width, node.height);
    if (longest > 0 && longest * scale > ASSET_MAX_DIMENSION) {
      scale = Math.max(1, ASSET_MAX_DIMENSION / longest);
    }
  }
  return node.exportAsync({ format: format, constraint: { type: "SCALE", value: scale } });
}

// Never throws — per-node failures become skipped entries the agent can act on.
async function requestAssets(
  link: string | null,
  requestedIds: readonly string[] | null,
  forcedFormat: AssetFormat | null
): Promise<AssetsPayload> {
  // The root scopes the automatic sweep and names the payload. Explicit node
  // ids are self-sufficient — a selection that vanished mid-flight must not
  // block a by-id export.
  let root: BaseNode | null = null;
  const resolution = await requestRoot(link);
  if (resolution.ok) {
    root = resolution.root;
  } else if (requestedIds === null || requestedIds.length === 0) {
    return { ok: false, error: resolution.error, componentName: null, assets: null, skipped: null };
  }

  const skipped: SkippedAsset[] = [];
  const targets: { node: SceneNode; format: AssetFormat }[] = [];

  if (requestedIds !== null && requestedIds.length > 0) {
    const ids = requestedIds.slice(0, MAX_REQUESTED_ASSETS);
    for (let i = MAX_REQUESTED_ASSETS; i < requestedIds.length; i++) {
      skipped.push({
        nodeId: requestedIds[i],
        name: "",
        reason: "per-call limit of " + MAX_REQUESTED_ASSETS + " node ids reached"
      });
    }
    for (const id of ids) {
      const nodeId = normalizeNodeIdParam(id);
      if (nodeId === null) {
        skipped.push({ nodeId: id, name: "", reason: "not a valid node id" });
        continue;
      }
      const node = await findNodeById(nodeId);
      if (node === null || node.type === "PAGE" || node.type === "DOCUMENT") {
        skipped.push({ nodeId: nodeId, name: "", reason: "not found in the open file" });
        continue;
      }
      const sceneNode = node as SceneNode;
      targets.push({
        node: sceneNode,
        format: forcedFormat === null ? inferredAssetFormat(sceneNode) : forcedFormat
      });
    }
  } else if (root !== null) {
    for (const node of collectAssetNodes(root)) {
      targets.push({
        node: node,
        format: forcedFormat === null ? inferredAssetFormat(node) : forcedFormat
      });
    }
  }

  const usedNames = new Set<string>();
  const assets: ExportedAsset[] = [];
  let totalBytes = 0;
  let sizeCapped = false;

  for (const target of targets) {
    const label = target.node.name.trim() === "" ? "asset" : target.node.name.trim();
    if (assets.length >= MAX_ASSETS) {
      skipped.push({
        nodeId: target.node.id,
        name: label,
        reason: "asset count limit of " + MAX_ASSETS + " reached"
      });
      continue;
    }
    if (sizeCapped) {
      skipped.push({ nodeId: target.node.id, name: label, reason: "total size limit reached" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await exportAssetBytes(target.node, target.format);
    } catch (error) {
      skipped.push({
        nodeId: target.node.id,
        name: label,
        reason: "export failed: " + errorMessage(error)
      });
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      skipped.push({
        nodeId: target.node.id,
        name: label,
        reason: "larger than " + MAX_ASSET_BYTES / 1024 + " KB"
      });
      continue;
    }
    if (totalBytes + bytes.length > MAX_TOTAL_ASSET_BYTES) {
      sizeCapped = true;
      skipped.push({ nodeId: target.node.id, name: label, reason: "total size limit reached" });
      continue;
    }
    totalBytes += bytes.length;

    const base = assetFileName(target.node.name);
    const extension = assetFileExtension(target.format);
    let name = base + "." + extension;
    let n = 2;
    while (usedNames.has(name)) {
      name = base + "-" + n + "." + extension;
      n += 1;
    }
    usedNames.add(name);

    assets.push({
      name: name,
      nodeId: target.node.id,
      format: target.format,
      mimeType: mimeTypeFor(target.format),
      bytes: bytes
    });
  }

  return {
    ok: true,
    error: null,
    componentName: root === null ? null : root.name,
    assets: assets,
    skipped: skipped.length === 0 ? null : skipped
  };
}

// Selection changes fire rapidly during a drag-select; only the newest preview
// is worth posting.
let previewSequence = 0;

async function sendPreview(): Promise<void> {
  previewSequence += 1;
  const sequence = previewSequence;

  // Spec first — it is fast, and the panel should not wait on a render.
  const payload = await requestSpec(null);
  if (sequence !== previewSequence) {
    return;
  }
  figma.ui.postMessage({
    type: "preview",
    ok: payload.ok,
    error: payload.error,
    componentName: payload.componentName,
    spec: payload.spec
  });

  const image = await requestImage(null);
  if (sequence !== previewSequence) {
    return;
  }
  figma.ui.postMessage({
    type: "preview_image",
    ok: image.ok,
    error: image.error,
    componentName: image.componentName,
    bytes: image.bytes
  });
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

figma.showUI(__html__, { width: UI_WIDTH, height: UI_HEIGHT, themeColors: true });

figma.ui.onmessage = async (message: unknown): Promise<void> => {
  if (!isRecord(message)) {
    return;
  }
  if (message.type === "extract") {
    const payload = await requestSpec(stringOrNull(message.link));
    figma.ui.postMessage({
      type: "spec_result",
      requestId: message.requestId,
      ok: payload.ok,
      error: payload.error,
      componentName: payload.componentName,
      spec: payload.spec
    });
    return;
  }
  if (message.type === "export_image") {
    const image = await requestImage(stringOrNull(message.link));
    figma.ui.postMessage({
      type: "image_result",
      requestId: message.requestId,
      ok: image.ok,
      error: image.error,
      componentName: image.componentName,
      bytes: image.bytes
    });
    return;
  }
  if (message.type === "export_assets") {
    const nodeIds = Array.isArray(message.nodeIds)
      ? message.nodeIds.filter((id): id is string => typeof id === "string")
      : null;
    const rawFormat = typeof message.format === "string" ? message.format : "";
    const forcedFormat: AssetFormat | null =
      rawFormat === "SVG" || rawFormat === "PNG" || rawFormat === "JPG" ? rawFormat : null;
    const payload = await requestAssets(stringOrNull(message.link), nodeIds, forcedFormat);
    figma.ui.postMessage({
      type: "assets_result",
      requestId: message.requestId,
      ok: payload.ok,
      error: payload.error,
      componentName: payload.componentName,
      assets: payload.assets,
      skipped: payload.skipped
    });
    return;
  }
  if (message.type === "refresh") {
    await sendPreview();
  }
};

figma.on("selectionchange", () => {
  void sendPreview();
});

// One preview on open, so the panel is never blank.
void sendPreview();
