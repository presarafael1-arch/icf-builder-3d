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

// Full analysis result from the external engine
export interface ExternalEngineAnalysis {
  graph: LayoutGraph;
  courses: CoursesInfo;
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
  baseUrl: 'http://127.0.0.1:8001',
  thickness: 220,
  wallHeight: 2800,
  courseHeight: 400,
  offsetEven: 0,
  offsetOdd: 600,
};
