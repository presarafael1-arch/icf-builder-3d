/**
 * Types for External ICF Engine API
 * 
 * These types match the FastAPI backend response structure from:
 * POST /project/layout?units=m&thickness={thickness}&wall_height={wallHeight}&course_height={courseHeight}&offset_even={offsetEven}&offset_odd={offsetOdd}
 */

// Engine mode: use external FastAPI backend or internal Lovable calculations
export type EngineMode = 'external' | 'internal';

// 3D Vector from backend
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Axis information for a wall
export interface WallAxis {
  u: Vec3;  // Unit vector along wall direction
  n: Vec3;  // Normal vector (perpendicular)
}

// Wall offset polylines (left/right sides of wall)
export interface WallOffsets {
  left: Vec3[];   // Polyline for left side
  right: Vec3[];  // Polyline for right side
}

// Node (junction point) from the graph
export interface GraphNode {
  id: string;
  position: Vec3;
  walls: string[];  // Wall IDs connected to this node
}

// Wall from the graph
export interface GraphWall {
  id: string;
  start_node: string;
  end_node: string;
  length: number;
  axis: WallAxis;
  offsets?: WallOffsets;
}

// Graph structure
export interface LayoutGraph {
  nodes: GraphNode[];
  walls: GraphWall[];
  thickness: number;
}

// Course (row/fiada) pattern
export type CoursePattern = 'A' | 'B';

// Individual course definition
export interface Course {
  index: number;
  z0: number;           // Bottom Z
  z1: number;           // Top Z
  pattern: CoursePattern;
  shift_along_wall: number;  // Offset for pattern B
}

// Courses information
export interface CoursesInfo {
  wall_height: number;
  course_height: number;
  count: number;
  courses: Course[];
}

// Panel from backend (for panel-level rendering)
export interface EnginePanel {
  wall_id: string;
  course: number;
  x0: number;
  x1: number;
  type: 'FULL' | 'CUT';
  cut_reason?: string;
}

// Full analysis result from the external engine
export interface ExternalEngineAnalysis {
  graph?: LayoutGraph;
  courses?: CoursesInfo;
  walls?: GraphWall[];
  panels?: EnginePanel[];
  meta?: { units?: string };
}

// Normalized analysis with safe defaults (never undefined)
export interface NormalizedExternalAnalysis {
  nodes: GraphNode[];
  walls: GraphWall[];
  courses: Course[];
  panels: EnginePanel[];
  wallHeight: number;
  courseHeight: number;
  thickness: number;
}

/**
 * Robust normalizer for the raw API response.
 * Supports multiple response formats:
 * - walls at: analysis.graph.walls, analysis.walls, root.walls
 * - panels at: analysis.panels, root.panels
 * - courses at: analysis.courses, root.courses
 * - nodes at: analysis.graph.nodes, root.nodes
 */
export function normalizeExternalAnalysis(data: unknown): NormalizedExternalAnalysis {
  const root = (data ?? {}) as Record<string, unknown>;
  const analysis = (root.analysis ?? {}) as Record<string, unknown>;
  const graph = (analysis.graph ?? {}) as Record<string, unknown>;
  const coursesObj = (analysis.courses ?? root.courses ?? {}) as Record<string, unknown>;

  // Walls: try analysis.graph.walls -> analysis.walls -> root.walls
  const walls = (
    (graph.walls as GraphWall[]) ??
    (analysis.walls as GraphWall[]) ??
    (root.walls as GraphWall[]) ??
    []
  );

  // Panels: try analysis.panels -> root.panels
  const panels = (
    (analysis.panels as EnginePanel[]) ??
    (root.panels as EnginePanel[]) ??
    []
  );

  // Nodes: try analysis.graph.nodes -> root.nodes
  const nodes = (
    (graph.nodes as GraphNode[]) ??
    (root.nodes as GraphNode[]) ??
    []
  );

  // Courses array: try coursesObj.courses -> if coursesObj is an array, use it directly
  const coursesArray = Array.isArray(coursesObj)
    ? (coursesObj as Course[])
    : ((coursesObj.courses as Course[]) ?? []);

  // Height values
  const wallHeight = (coursesObj.wall_height as number) ?? 0;
  const courseHeight = (coursesObj.course_height as number) ?? 0;
  const thickness = (graph.thickness as number) ?? (analysis.thickness as number) ?? (root.thickness as number) ?? 0;

  // Ensure wall IDs are always unique.
  // Some backends may emit duplicated/empty wall ids; that breaks selection (multiple walls become selected).
  const wallIdMap = new Map<string, string>(); // original -> normalized
  const usedWallIds = new Set<string>();

  const normalizedWalls: GraphWall[] = walls.map((w, idx) => {
    const rawId = typeof (w as any)?.id === 'string' ? (w as any).id : '';
    const baseId = rawId.trim() || `wall`;
    let nextId = baseId;
    if (usedWallIds.has(nextId)) {
      nextId = `${baseId}-${idx}`;
    }
    // still defensive
    while (usedWallIds.has(nextId)) {
      nextId = `${baseId}-${idx}-${Math.random().toString(16).slice(2, 6)}`;
    }

    usedWallIds.add(nextId);
    wallIdMap.set(rawId, nextId);

    return {
      ...w,
      id: nextId,
    };
  });

  const normalizedPanels: EnginePanel[] = panels.map((p, idx) => {
    const rawWallId = typeof (p as any)?.wall_id === 'string' ? (p as any).wall_id : '';
    const mapped = wallIdMap.get(rawWallId);
    return {
      ...p,
      wall_id: mapped ?? (rawWallId || `wall-${idx}`),
    };
  });

  const normalizedNodes: GraphNode[] = nodes.map((n) => {
    const ws = Array.isArray((n as any)?.walls) ? ((n as any).walls as string[]) : [];
    return {
      ...n,
      walls: ws.map((wid) => wallIdMap.get(wid) ?? wid),
    };
  });

  console.log('[ExternalEngine] walls:', walls.length, 'panels:', panels.length, 'units:', (root.meta as { units?: string })?.units ?? 'n/a');

  return {
    nodes: normalizedNodes,
    walls: normalizedWalls,
    courses: coursesArray,
    panels: normalizedPanels,
    wallHeight,
    courseHeight,
    thickness,
  };
}

// Engine configuration
// Note: All values are stored in mm in the UI, converted to m when calling API
export interface EngineConfig {
  baseUrl: string;
  thickness: number;      // mm
  wallHeight: number;     // mm
  courseHeight: number;   // mm
  offsetEven: number;     // mm
  offsetOdd: number;      // mm
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  baseUrl: 'https://museums-usual-township-realm.trycloudflare.com',
  thickness: 280,
  wallHeight: 2800,
  courseHeight: 400,
  offsetEven: 0,
  offsetOdd: 200,
};
