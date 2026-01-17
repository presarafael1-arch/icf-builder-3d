import { useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Panel dimensions (mm)
const PANEL_WIDTH_MM = 1200;
const PANEL_HEIGHT_MM = 400;
const PANEL_THICKNESS_MM = 70.59;

// Scale factor: mm to meters (3D units)
const SCALE = 0.001;

// Rib configuration for procedural geometry
const RIB_COUNT = 5; // Number of vertical ribs
const RIB_WIDTH_MM = 20;
const RIB_DEPTH_MM = 15; // How deep the ribs protrude
const SLOT_WIDTH_MM = 40; // Width of web slots
const SLOT_HEIGHT_MM = 30;
const SLOT_POSITIONS = [300, 600, 900]; // mm from left edge

export interface PanelGeometryResult {
  geometry: THREE.BufferGeometry;
  outlineGeometry: THREE.BufferGeometry;
  isHighFidelity: boolean;
  isLoading: boolean;
  error: string | null;
}

/**
 * Creates a detailed procedural geometry representing an ICF panel
 * with ribs, web slots, and surface detail
 */
function createDetailedPanelGeometry(): THREE.BufferGeometry {
  const width = PANEL_WIDTH_MM * SCALE;
  const height = PANEL_HEIGHT_MM * SCALE;
  const thickness = PANEL_THICKNESS_MM * SCALE;
  
  const ribWidth = RIB_WIDTH_MM * SCALE;
  const ribDepth = RIB_DEPTH_MM * SCALE;
  const slotWidth = SLOT_WIDTH_MM * SCALE;
  const slotHeight = SLOT_HEIGHT_MM * SCALE;
  
  // Create compound geometry using CSG-like approach with multiple boxes
  const group = new THREE.Group();
  
  // Main body (slightly thinner to accommodate ribs)
  const bodyWidth = width;
  const bodyHeight = height;
  const bodyThickness = thickness - ribDepth * 2;
  
  const bodyGeo = new THREE.BoxGeometry(bodyWidth, bodyHeight, bodyThickness);
  const bodyMesh = new THREE.Mesh(bodyGeo);
  bodyMesh.position.set(0, 0, 0);
  group.add(bodyMesh);
  
  // Vertical ribs on front face
  const ribSpacing = width / (RIB_COUNT + 1);
  for (let i = 1; i <= RIB_COUNT; i++) {
    const ribGeo = new THREE.BoxGeometry(ribWidth, height, ribDepth);
    const ribMesh = new THREE.Mesh(ribGeo);
    const xPos = -width / 2 + ribSpacing * i;
    ribMesh.position.set(xPos, 0, thickness / 2 - ribDepth / 2);
    group.add(ribMesh);
    
    // Mirror on back face
    const ribMeshBack = new THREE.Mesh(ribGeo);
    ribMeshBack.position.set(xPos, 0, -thickness / 2 + ribDepth / 2);
    group.add(ribMeshBack);
  }
  
  // Horizontal ribs (top and bottom edges)
  const hRibGeo = new THREE.BoxGeometry(width, ribWidth * 0.5, ribDepth);
  
  // Top front
  const topRibFront = new THREE.Mesh(hRibGeo);
  topRibFront.position.set(0, height / 2 - ribWidth * 0.25, thickness / 2 - ribDepth / 2);
  group.add(topRibFront);
  
  // Bottom front
  const bottomRibFront = new THREE.Mesh(hRibGeo);
  bottomRibFront.position.set(0, -height / 2 + ribWidth * 0.25, thickness / 2 - ribDepth / 2);
  group.add(bottomRibFront);
  
  // Top back
  const topRibBack = new THREE.Mesh(hRibGeo);
  topRibBack.position.set(0, height / 2 - ribWidth * 0.25, -thickness / 2 + ribDepth / 2);
  group.add(topRibBack);
  
  // Bottom back
  const bottomRibBack = new THREE.Mesh(hRibGeo);
  bottomRibBack.position.set(0, -height / 2 + ribWidth * 0.25, -thickness / 2 + ribDepth / 2);
  group.add(bottomRibBack);
  
  // Merge all geometries
  const geometries: THREE.BufferGeometry[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const cloned = child.geometry.clone();
      cloned.applyMatrix4(child.matrixWorld);
      geometries.push(cloned);
    }
  });
  
  // Use BufferGeometryUtils-like merging
  const merged = mergeBufferGeometries(geometries);
  
  // Center the geometry
  merged.computeBoundingBox();
  if (merged.boundingBox) {
    merged.translate(
      -(merged.boundingBox.min.x + merged.boundingBox.max.x) / 2,
      -(merged.boundingBox.min.y + merged.boundingBox.max.y) / 2,
      -(merged.boundingBox.min.z + merged.boundingBox.max.z) / 2
    );
  }
  
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  
  return merged;
}

/**
 * Simple merge of buffer geometries (non-indexed)
 */
function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  
  geometries.forEach((geo) => {
    const posAttr = geo.getAttribute('position');
    const normAttr = geo.getAttribute('normal');
    
    if (posAttr) {
      for (let i = 0; i < posAttr.count; i++) {
        positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      }
    }
    
    if (normAttr) {
      for (let i = 0; i < normAttr.count; i++) {
        normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      }
    }
  });
  
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length > 0) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  }
  
  return merged;
}

/**
 * Creates a simple box geometry (fallback/low-fidelity mode)
 */
function createSimplePanelGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(
    PANEL_WIDTH_MM * SCALE,
    PANEL_HEIGHT_MM * SCALE,
    PANEL_THICKNESS_MM * SCALE
  );
}

/**
 * Creates outline geometry for panel edges
 */
function createOutlineGeometry(): THREE.BufferGeometry {
  const boxGeo = new THREE.BoxGeometry(
    PANEL_WIDTH_MM * SCALE,
    PANEL_HEIGHT_MM * SCALE,
    PANEL_THICKNESS_MM * SCALE
  );
  return new THREE.EdgesGeometry(boxGeo);
}

/**
 * Attempts to load GLB geometry from a file
 */
async function loadGLBGeometry(url: string): Promise<THREE.BufferGeometry | null> {
  return new Promise((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        // Find the first mesh in the scene
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry && !geometry) {
            geometry = child.geometry.clone();
            
            // Normalize the geometry: center it and scale to our units
            geometry.computeBoundingBox();
            if (geometry.boundingBox) {
              const bbox = geometry.boundingBox;
              const center = new THREE.Vector3();
              bbox.getCenter(center);
              
              // Center the geometry
              geometry.translate(-center.x, -center.y, -center.z);
              
              // Calculate scale to match our panel dimensions
              const size = new THREE.Vector3();
              bbox.getSize(size);
              
              // Assume the GLB is in mm, scale to meters
              const targetWidth = PANEL_WIDTH_MM * SCALE;
              const currentWidth = size.x;
              
              if (currentWidth > 0) {
                const scaleFactor = targetWidth / currentWidth;
                geometry.scale(scaleFactor, scaleFactor, scaleFactor);
              }
            }
            
            geometry.computeVertexNormals();
            geometry.computeBoundingSphere();
          }
        });
        resolve(geometry);
      },
      undefined,
      (error) => {
        console.warn('[usePanelGeometry] GLB load failed:', error);
        resolve(null);
      }
    );
  });
}

/**
 * Hook that provides panel geometry with optional high-fidelity GLB loading
 */
export function usePanelGeometry(highFidelity: boolean = false): PanelGeometryResult {
  const [glbGeometry, setGlbGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Try to load GLB when high fidelity is enabled
  useEffect(() => {
    if (!highFidelity) {
      setGlbGeometry(null);
      setError(null);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    // Try to load the GLB file
    loadGLBGeometry('/assets/panels/1200_b26.glb')
      .then((geo) => {
        if (geo) {
          setGlbGeometry(geo);
          console.log('[usePanelGeometry] GLB loaded successfully');
        } else {
          setError('GLB not available, using procedural geometry');
          console.log('[usePanelGeometry] GLB not found, using procedural fallback');
        }
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [highFidelity]);
  
  // Generate geometry based on mode
  const result = useMemo((): PanelGeometryResult => {
    const outlineGeometry = createOutlineGeometry();
    
    if (highFidelity) {
      // If GLB is available, use it
      if (glbGeometry) {
        return {
          geometry: glbGeometry,
          outlineGeometry,
          isHighFidelity: true,
          isLoading: false,
          error: null,
        };
      }
      
      // Otherwise use detailed procedural geometry
      return {
        geometry: createDetailedPanelGeometry(),
        outlineGeometry,
        isHighFidelity: true,
        isLoading,
        error,
      };
    }
    
    // Low fidelity: simple box
    return {
      geometry: createSimplePanelGeometry(),
      outlineGeometry,
      isHighFidelity: false,
      isLoading: false,
      error: null,
    };
  }, [highFidelity, glbGeometry, isLoading, error]);
  
  return result;
}

export default usePanelGeometry;
