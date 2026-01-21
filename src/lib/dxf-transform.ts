/**
 * DXF Transform Utilities
 * 
 * Applies mirror (Y/X) and rotation transformations to wall segments
 * before chain building and footprint detection.
 */

import { WallSegment } from '@/types/icf';

export interface DXFTransformSettings {
  flipY: boolean;       // Mirror around Y axis (y' = centerY - (y - centerY))
  mirrorX: boolean;     // Mirror around X axis (x' = centerX - (x - centerX))
  rotation: 0 | 90 | 180 | 270;  // Rotation in degrees (clockwise)
}

/**
 * Calculate bounding box center of wall segments
 */
function calculateCenter(walls: WallSegment[]): { x: number; y: number } {
  if (walls.length === 0) return { x: 0, y: 0 };
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  
  for (const wall of walls) {
    minX = Math.min(minX, wall.startX, wall.endX);
    maxX = Math.max(maxX, wall.startX, wall.endX);
    minY = Math.min(minY, wall.startY, wall.endY);
    maxY = Math.max(maxY, wall.startY, wall.endY);
  }
  
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}

/**
 * Transform a single point around center
 */
function transformPoint(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  settings: DXFTransformSettings
): { x: number; y: number } {
  // Translate to origin (center)
  let px = x - centerX;
  let py = y - centerY;
  
  // Apply rotation (clockwise)
  if (settings.rotation !== 0) {
    const rad = (settings.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const newX = px * cos + py * sin;
    const newY = -px * sin + py * cos;
    px = newX;
    py = newY;
  }
  
  // Apply mirror X (flip around Y axis at center)
  if (settings.mirrorX) {
    px = -px;
  }
  
  // Apply mirror Y (flip around X axis at center)
  if (settings.flipY) {
    py = -py;
  }
  
  // Translate back
  return {
    x: px + centerX,
    y: py + centerY,
  };
}

/**
 * Apply DXF transformations to wall segments
 * Returns new wall segments with transformed coordinates
 * 
 * IMPORTANT: This function is idempotent - it always uses the original
 * walls' bounding box center for transformations.
 */
export function applyDXFTransform(
  walls: WallSegment[],
  settings: DXFTransformSettings
): WallSegment[] {
  // If no transformations are needed, return as-is
  if (!settings.flipY && !settings.mirrorX && settings.rotation === 0) {
    return walls;
  }
  
  if (walls.length === 0) return [];
  
  // Calculate center once for all transformations
  const center = calculateCenter(walls);
  
  return walls.map(wall => {
    const start = transformPoint(wall.startX, wall.startY, center.x, center.y, settings);
    const end = transformPoint(wall.endX, wall.endY, center.x, center.y, settings);
    
    // Recalculate length and angle
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    
    return {
      ...wall,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      length,
      angle,
    };
  });
}

/**
 * Get default DXF transform settings
 */
export function getDefaultDXFTransformSettings(): DXFTransformSettings {
  return {
    flipY: false,
    mirrorX: false,
    rotation: 0,
  };
}

/**
 * Load DXF transform settings from localStorage for a project
 */
export function loadDXFTransformSettings(projectId: string): DXFTransformSettings {
  try {
    const stored = localStorage.getItem(`omni-icf-dxf-transform-${projectId}`);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        flipY: Boolean(parsed.flipY),
        mirrorX: Boolean(parsed.mirrorX),
        rotation: [0, 90, 180, 270].includes(parsed.rotation) ? parsed.rotation : 0,
      };
    }
  } catch (e) {
    console.warn('[DXFTransform] Failed to load settings:', e);
  }
  return getDefaultDXFTransformSettings();
}

/**
 * Save DXF transform settings to localStorage for a project
 */
export function saveDXFTransformSettings(projectId: string, settings: DXFTransformSettings): void {
  try {
    localStorage.setItem(`omni-icf-dxf-transform-${projectId}`, JSON.stringify(settings));
  } catch (e) {
    console.warn('[DXFTransform] Failed to save settings:', e);
  }
}
