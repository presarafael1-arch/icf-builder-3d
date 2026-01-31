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
  meta?: {
    units?: string;
    wall_thickness?: number;        // Total wall thickness in meters
    wall_thickness_mm?: number;     // Total wall thickness in mm
    panel_thickness_mm?: number;    // Single skin/panel thickness in mm
  };
}

// Normalized analysis with safe defaults (never undefined)
export interface NormalizedExternalAnalysis {
  nodes: GraphNode[];
  walls: GraphWall[];
  courses: Course[];
  panels: EnginePanel[];
  wallHeight: number;
  courseHeight: number;
  thickness: number;              // Concrete core thickness in meters
  
  // New: thickness values from meta (in meters for easy use in geometry)
  wallThickness: number;          // Total wall thickness (EPS + core + EPS) in meters
  panelThickness: number;         // Single EPS/skin thickness in meters

  /**
   * Optional footprint polygon (may exist in different places in the raw payload).
   * Kept as unknown/any on purpose to preserve backend compatibility.
   */
  outerPolygon?: unknown;
  footprint?: unknown;
  meta?: unknown;
  analysis?: unknown;
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

  // Extract meta thickness values
  const metaObj = (root.meta ?? analysis.meta ?? {}) as Record<string, unknown>;
  
  // Wall thickness: try meta.wall_thickness (m) or meta.wall_thickness_mm (mm -> m)
  const wallThicknessFromMeta = (metaObj.wall_thickness as number) ?? 
    ((metaObj.wall_thickness_mm as number) ?? 0) / 1000;
  // Default: 2 EPS skins (70.6mm each) + core thickness
  const DEFAULT_EPS = 0.0706;
  const wallThickness = wallThicknessFromMeta > 0 ? wallThicknessFromMeta : (thickness > 0 ? thickness + 2 * DEFAULT_EPS : 0.22);
  
  // Panel/skin thickness: try meta.panel_thickness_mm (mm -> m), default to 1 TOOTH (~70.6mm)
  const panelThicknessFromMeta = ((metaObj.panel_thickness_mm as number) ?? 0) / 1000;
  const panelThickness = panelThicknessFromMeta > 0 ? panelThicknessFromMeta : DEFAULT_EPS;

  console.log('[ExternalEngine] walls:', walls.length, 'panels:', panels.length, 'units:', (root.meta as { units?: string })?.units ?? 'n/a', 'wallThickness:', wallThickness.toFixed(4), 'panelThickness:', panelThickness.toFixed(4));

  return {
    nodes,
    walls,
    courses: coursesArray,
    panels,
    wallHeight,
    courseHeight,
    thickness,
    wallThickness,
    panelThickness,

    // Preserve raw footprint metadata for renderers that need concave envelopes
    analysis: root.analysis,
    meta: root.meta,
    footprint: root.footprint,
    outerPolygon: (root as any).outerPolygon,
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
