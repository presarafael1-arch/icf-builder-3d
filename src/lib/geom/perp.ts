/**
 * Unified Perpendicular Vector Utilities
 * 
 * CONVENTION:
 * - Wall direction: (dirX, dirY) in 2D or (dirX, 0, dirZ) in 3D
 * - Positive perpendicular: 90° CLOCKWISE from wall direction when viewed from above
 *   - In 2D (XY plane): perp = (dirY, -dirX)
 *   - In 3D (XZ plane): perp = (dirZ, 0, -dirX) when dir is (dirX, 0, dirZ)
 * 
 * "Positive perpendicular" = "right" side when looking along the wall direction
 * 
 * This MUST be consistent between:
 * - footprint-detection.ts (classifying which side is exterior)
 * - panel-layout.ts (placing panels on exterior/interior side)
 */

/**
 * Get perpendicular vector in 2D XY plane (for footprint detection)
 * Returns the "right" side when looking along (dirX, dirY)
 * 
 * @param dirX - X component of normalized direction
 * @param dirY - Y component of normalized direction
 * @returns Perpendicular vector pointing to "positive" side (right when looking along direction)
 */
export function getPerpXY(dirX: number, dirY: number): { perpX: number; perpY: number } {
  // 90° CW rotation in XY plane: (x, y) -> (y, -x)
  return {
    perpX: dirY,
    perpY: -dirX,
  };
}

/**
 * Get perpendicular vector in 3D XZ plane (for panel placement)
 * Y is up/height, XZ is the ground plane
 * Returns the "right" side when looking along (dirX, dirZ)
 * 
 * @param dirX - X component of normalized direction
 * @param dirZ - Z component of normalized direction
 * @returns Perpendicular vector pointing to "positive" side (right when looking along direction)
 */
export function getPerpXZ(dirX: number, dirZ: number): { perpX: number; perpZ: number } {
  // 90° CW rotation in XZ plane (viewed from above, Y up): (x, z) -> (z, -x)
  // This matches the XY convention where (dirX, dirY) -> (dirY, -dirX)
  return {
    perpX: dirZ,
    perpZ: -dirX,
  };
}

/**
 * Normalize a 2D vector
 */
export function normalize2D(x: number, y: number): { nx: number; ny: number; length: number } {
  const length = Math.sqrt(x * x + y * y);
  if (length < 1e-10) {
    return { nx: 1, ny: 0, length: 0 };
  }
  return {
    nx: x / length,
    ny: y / length,
    length,
  };
}

/**
 * Get wall direction and perpendicular from start/end points (2D)
 */
export function getWallVectors2D(
  startX: number, startY: number,
  endX: number, endY: number
): {
  dirX: number;
  dirY: number;
  perpX: number;
  perpY: number;
  length: number;
} {
  const dx = endX - startX;
  const dy = endY - startY;
  const { nx, ny, length } = normalize2D(dx, dy);
  const perp = getPerpXY(nx, ny);
  
  return {
    dirX: nx,
    dirY: ny,
    perpX: perp.perpX,
    perpY: perp.perpY,
    length,
  };
}

/**
 * Get wall direction and perpendicular from start/end points (3D, XZ plane)
 * Note: In 3D, Y coordinate becomes Z coordinate (Y is height)
 */
export function getWallVectors3D(
  startX: number, startZ: number,
  endX: number, endZ: number
): {
  dirX: number;
  dirZ: number;
  perpX: number;
  perpZ: number;
  length: number;
} {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const length = Math.sqrt(dx * dx + dz * dz);
  
  if (length < 1e-10) {
    return { dirX: 1, dirZ: 0, perpX: 0, perpZ: -1, length: 0 };
  }
  
  const dirX = dx / length;
  const dirZ = dz / length;
  const perp = getPerpXZ(dirX, dirZ);
  
  return {
    dirX,
    dirZ,
    perpX: perp.perpX,
    perpZ: perp.perpZ,
    length,
  };
}
