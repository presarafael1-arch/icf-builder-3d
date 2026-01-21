// DXF Transform Utilities for OMNI ICF WALLS 3D PLANNER
// Handles mirroring and rotation of DXF coordinates

export interface DXFTransformSettings {
  mirrorX: boolean;    // Mirror along X axis (flip X coordinates)
  mirrorY: boolean;    // Mirror along Y axis (flip Y coordinates) - default true for DXF
  rotateDeg: 0 | 90 | 180 | 270;  // Rotation in degrees
}

export const DEFAULT_DXF_TRANSFORM: DXFTransformSettings = {
  mirrorX: false,
  mirrorY: true,   // Default ON - DXF Y axis is typically inverted
  rotateDeg: 0,
};

/**
 * Transform a single DXF point according to transform settings.
 * Applied BEFORE building chains/footprint to fix orientation.
 */
export function transformDxfPoint(
  x: number, 
  y: number, 
  settings: DXFTransformSettings
): { x: number; y: number } {
  let tx = x;
  let ty = y;
  
  // Step 1: Apply mirroring
  if (settings.mirrorX) tx = -tx;
  if (settings.mirrorY) ty = -ty;
  
  // Step 2: Apply rotation
  switch (settings.rotateDeg) {
    case 0:
      // No rotation
      return { x: tx, y: ty };
    case 90:
      return { x: -ty, y: tx };
    case 180:
      return { x: -tx, y: -ty };
    case 270:
      return { x: ty, y: -tx };
    default:
      return { x: tx, y: ty };
  }
}

/**
 * Transform an array of DXF segments according to transform settings.
 */
export function transformDxfSegments<T extends { startX: number; startY: number; endX: number; endY: number }>(
  segments: T[],
  settings: DXFTransformSettings
): T[] {
  return segments.map(seg => {
    const start = transformDxfPoint(seg.startX, seg.startY, settings);
    const end = transformDxfPoint(seg.endX, seg.endY, settings);
    return {
      ...seg,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
    };
  });
}

/**
 * Transform wall segments (WallSegment format)
 */
export function transformWallSegments<T extends { startX: number; startY: number; endX: number; endY: number }>(
  walls: T[],
  settings: DXFTransformSettings
): T[] {
  return transformDxfSegments(walls, settings);
}

/**
 * Storage key for DXF transform settings per project
 */
export function getDxfTransformStorageKey(projectId: string): string {
  return `omni-icf-dxf-transform-${projectId}`;
}

/**
 * Load DXF transform settings from localStorage
 */
export function loadDxfTransformSettings(projectId: string): DXFTransformSettings {
  try {
    const stored = localStorage.getItem(getDxfTransformStorageKey(projectId));
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<DXFTransformSettings>;
      return {
        mirrorX: parsed.mirrorX ?? DEFAULT_DXF_TRANSFORM.mirrorX,
        mirrorY: parsed.mirrorY ?? DEFAULT_DXF_TRANSFORM.mirrorY,
        rotateDeg: parsed.rotateDeg ?? DEFAULT_DXF_TRANSFORM.rotateDeg,
      };
    }
  } catch (e) {
    console.warn('[DXF Transform] Failed to load settings:', e);
  }
  return { ...DEFAULT_DXF_TRANSFORM };
}

/**
 * Save DXF transform settings to localStorage
 */
export function saveDxfTransformSettings(projectId: string, settings: DXFTransformSettings): void {
  try {
    localStorage.setItem(getDxfTransformStorageKey(projectId), JSON.stringify(settings));
  } catch (e) {
    console.warn('[DXF Transform] Failed to save settings:', e);
  }
}

/**
 * Check if DXF might be mirrored based on footprint classification results.
 * If >60% of chains are "outside footprint", the DXF is likely mirrored.
 */
export function detectPossibleMirror(
  totalChains: number,
  outsideChains: number
): boolean {
  if (totalChains === 0) return false;
  const outsideRatio = outsideChains / totalChains;
  return outsideRatio > 0.6;
}
