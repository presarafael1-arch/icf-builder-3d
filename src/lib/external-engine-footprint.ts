/**
 * External Engine Footprint helpers
 *
 * Builds a concave outer polygon from unordered 2D segments using a half-edge
 * face-walking algorithm (right-hand rule), then selecting the best candidate
 * face by containment count and area.
 *
 * Units: meters.
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface Segment2D {
  a: Point2D;
  b: Point2D;
  sourceId?: string;
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

export function signedPolygonArea(poly: Point2D[]): number {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}

function pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonCentroid(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

interface HalfEdge {
  from: string;
  to: string;
  angle: number;
  visited: boolean;
  twin?: HalfEdge;
  next?: HalfEdge;
}

interface Node {
  key: string;
  x: number;
  y: number;
  outgoing: HalfEdge[];
}

/**
 * Find the best outer polygon among all bounded faces.
 *
 * snapToleranceMeters: endpoint snapping tolerance in meters (e.g. 0.05 = 50mm)
 */
export function findOuterPolygonFromSegments(
  segments: Segment2D[],
  snapToleranceMeters: number = 0.05
): Point2D[] {
  if (segments.length === 0) return [];

  const tol = Math.max(1e-6, snapToleranceMeters);

  const getKey = (x: number, y: number) => {
    const rx = Math.round(x / tol) * tol;
    const ry = Math.round(y / tol) * tol;
    return `${rx},${ry}`;
  };

  const nodes = new Map<string, Node>();
  const allHalfEdges: HalfEdge[] = [];

  const getNode = (p: Point2D): Node => {
    const key = getKey(p.x, p.y);
    if (!nodes.has(key)) {
      const [sx, sy] = key.split(',').map(Number);
      nodes.set(key, { key, x: sx, y: sy, outgoing: [] });
    }
    return nodes.get(key)!;
  };

  for (const s of segments) {
    const a = getNode(s.a);
    const b = getNode(s.b);
    if (a.key === b.key) continue;

    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    const fwd: HalfEdge = { from: a.key, to: b.key, angle, visited: false };
    const bwd: HalfEdge = {
      from: b.key,
      to: a.key,
      angle: angle + Math.PI,
      visited: false,
    };
    fwd.twin = bwd;
    bwd.twin = fwd;
    a.outgoing.push(fwd);
    b.outgoing.push(bwd);
    allHalfEdges.push(fwd, bwd);
  }

  // sort outgoing edges by angle CCW
  for (const node of nodes.values()) {
    node.outgoing.sort((ea, eb) => normalizeAngle(ea.angle) - normalizeAngle(eb.angle));
  }

  // build next pointers using right-hand rule
  for (const he of allHalfEdges) {
    const arrival = nodes.get(he.to);
    if (!arrival || arrival.outgoing.length === 0) continue;

    const incoming = normalizeAngle(he.angle);
    const reverse = normalizeAngle(incoming + Math.PI);

    // choose first edge CW from reverse direction
    let best: HalfEdge | undefined;
    let bestDiff = Infinity;
    for (const out of arrival.outgoing) {
      if (out === he.twin && arrival.outgoing.length > 1) continue;
      const outA = normalizeAngle(out.angle);
      let diff = reverse - outA;
      if (diff <= 0) diff += Math.PI * 2;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = out;
      }
    }
    he.next = best ?? arrival.outgoing[0];
  }

  // walk faces
  const faces: Point2D[][] = [];
  for (const startEdge of allHalfEdges) {
    if (startEdge.visited) continue;

    const face: Point2D[] = [];
    let current: HalfEdge | undefined = startEdge;
    let guard = 0;
    const max = allHalfEdges.length + 16;

    while (current && !current.visited && guard < max) {
      guard++;
      current.visited = true;
      const from = nodes.get(current.from);
      if (from) face.push({ x: from.x, y: from.y });
      current = current.next;
      if (current === startEdge) break;
    }

    if (face.length >= 3) faces.push(face);
  }

  if (faces.length === 0) return [];

  // choose best face: max containsCount, then max area
  type FaceMeta = { face: Point2D[]; containsCount: number; areaAbs: number };
  const metas: FaceMeta[] = faces.map((face) => {
    const areaAbs = Math.abs(signedPolygonArea(face));
    const c = polygonCentroid(face);
    let containsCount = 0;
    for (const other of faces) {
      if (other === face) continue;
      const oc = polygonCentroid(other);
      if (pointInPolygon(oc, face)) containsCount++;
    }
    // If even the face centroid isn't inside itself (degenerate/self-intersect), penalize.
    if (!pointInPolygon(c, face)) containsCount -= 999;
    return { face, containsCount, areaAbs };
  });

  metas.sort((a, b) => {
    if (b.containsCount !== a.containsCount) return b.containsCount - a.containsCount;
    return b.areaAbs - a.areaAbs;
  });

  const bestFace = metas[0]?.face ?? [];
  if (bestFace.length < 3) return [];

  // Ensure CCW orientation (positive signed area)
  const area = signedPolygonArea(bestFace);
  if (area < 0) {
    console.log('[Footprint] Reversing polygon from CW to CCW');
    return [...bestFace].reverse();
  }
  return bestFace;
}
