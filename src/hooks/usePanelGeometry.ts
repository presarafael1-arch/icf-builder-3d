import { useMemo, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { 
  loadSTEPFromURL, 
  loadCachedGeometry, 
  cacheGeometry 
} from '@/lib/step-to-glb-client';

// Panel dimensions (mm)
const PANEL_WIDTH_MM = 1200;
const PANEL_HEIGHT_MM = 400;
const PANEL_THICKNESS_MM = 70.59;

// Scale factor: mm to meters (3D units)
const SCALE = 0.001;

// Rib configuration for procedural geometry
const RIB_COUNT = 5;
const RIB_WIDTH_MM = 20;
const RIB_DEPTH_MM = 15;

export interface PanelGeometryResult {
  geometry: THREE.BufferGeometry;
  outlineGeometry: THREE.BufferGeometry;
  isHighFidelity: boolean;
  isLoading: boolean;
  error: string | null;
  source: 'glb' | 'step' | 'cache' | 'procedural' | 'simple';
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
  
  const group = new THREE.Group();
  
  // Main body (slightly thinner to accommodate ribs)
  const bodyThickness = thickness - ribDepth * 2;
  const bodyGeo = new THREE.BoxGeometry(width, height, bodyThickness);
  const bodyMesh = new THREE.Mesh(bodyGeo);
  group.add(bodyMesh);
  
  // Vertical ribs
  const ribSpacing = width / (RIB_COUNT + 1);
  for (let i = 1; i <= RIB_COUNT; i++) {
    const ribGeo = new THREE.BoxGeometry(ribWidth, height, ribDepth);
    const xPos = -width / 2 + ribSpacing * i;
    
    // Front rib
    const ribMesh = new THREE.Mesh(ribGeo);
    ribMesh.position.set(xPos, 0, thickness / 2 - ribDepth / 2);
    group.add(ribMesh);
    
    // Back rib
    const ribMeshBack = new THREE.Mesh(ribGeo);
    ribMeshBack.position.set(xPos, 0, -thickness / 2 + ribDepth / 2);
    group.add(ribMeshBack);
  }
  
  // Horizontal edge ribs
  const hRibGeo = new THREE.BoxGeometry(width, ribWidth * 0.5, ribDepth);
  
  const positions = [
    { y: height / 2 - ribWidth * 0.25, z: thickness / 2 - ribDepth / 2 },
    { y: -height / 2 + ribWidth * 0.25, z: thickness / 2 - ribDepth / 2 },
    { y: height / 2 - ribWidth * 0.25, z: -thickness / 2 + ribDepth / 2 },
    { y: -height / 2 + ribWidth * 0.25, z: -thickness / 2 + ribDepth / 2 },
  ];
  
  for (const pos of positions) {
    const rib = new THREE.Mesh(hRibGeo);
    rib.position.set(0, pos.y, pos.z);
    group.add(rib);
  }
  
  // Merge geometries
  const geometries: THREE.BufferGeometry[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const cloned = child.geometry.clone();
      child.updateWorldMatrix(true, false);
      cloned.applyMatrix4(child.matrixWorld);
      geometries.push(cloned);
    }
  });
  
  const merged = mergeBufferGeometries(geometries);
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

function createSimplePanelGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(
    PANEL_WIDTH_MM * SCALE,
    PANEL_HEIGHT_MM * SCALE,
    PANEL_THICKNESS_MM * SCALE
  );
}

function createOutlineGeometry(): THREE.BufferGeometry {
  const boxGeo = new THREE.BoxGeometry(
    PANEL_WIDTH_MM * SCALE,
    PANEL_HEIGHT_MM * SCALE,
    PANEL_THICKNESS_MM * SCALE
  );
  return new THREE.EdgesGeometry(boxGeo);
}

async function loadGLBGeometry(url: string): Promise<THREE.BufferGeometry | null> {
  return new Promise((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry && !geometry) {
            geometry = child.geometry.clone();
            
            geometry.computeBoundingBox();
            if (geometry.boundingBox) {
              const center = new THREE.Vector3();
              geometry.boundingBox.getCenter(center);
              geometry.translate(-center.x, -center.y, -center.z);
              
              const size = new THREE.Vector3();
              geometry.boundingBox.getSize(size);
              
              const targetWidth = PANEL_WIDTH_MM * SCALE;
              const currentWidth = Math.max(size.x, size.y, size.z);
              
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
      () => resolve(null)
    );
  });
}

/**
 * Hook that provides panel geometry with real STEP/GLB loading
 */
export function usePanelGeometry(highFidelity: boolean = false): PanelGeometryResult {
  const [realGeometry, setRealGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<PanelGeometryResult['source']>('simple');
  
  const loadRealGeometry = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // 1. Try to load from cache first
      const cached = loadCachedGeometry();
      if (cached) {
        setRealGeometry(cached);
        setSource('cache');
        setIsLoading(false);
        console.log('[usePanelGeometry] Loaded from cache');
        return;
      }
      
      // 2. Try to load pre-converted GLB
      const glbGeometry = await loadGLBGeometry('/assets/panels/1200_b26.glb');
      if (glbGeometry) {
        setRealGeometry(glbGeometry);
        setSource('glb');
        cacheGeometry(glbGeometry);
        console.log('[usePanelGeometry] Loaded from GLB');
        setIsLoading(false);
        return;
      }
      
      // 3. Try to convert STEP directly in browser
      console.log('[usePanelGeometry] GLB not found, trying STEP conversion...');
      try {
        const stepGeometry = await loadSTEPFromURL('/assets/panels/1200_b26.step');
        setRealGeometry(stepGeometry);
        setSource('step');
        cacheGeometry(stepGeometry);
        console.log('[usePanelGeometry] Converted from STEP');
        setIsLoading(false);
        return;
      } catch (stepError) {
        console.warn('[usePanelGeometry] STEP conversion failed:', stepError);
      }
      
      // 4. Fallback to procedural geometry
      console.log('[usePanelGeometry] Using procedural geometry fallback');
      const procedural = createDetailedPanelGeometry();
      setRealGeometry(procedural);
      setSource('procedural');
      setError('Real geometry unavailable, using procedural');
      
    } catch (err) {
      console.error('[usePanelGeometry] Error loading geometry:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setRealGeometry(createDetailedPanelGeometry());
      setSource('procedural');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (highFidelity) {
      loadRealGeometry();
    } else {
      setRealGeometry(null);
      setSource('simple');
      setError(null);
    }
  }, [highFidelity, loadRealGeometry]);
  
  const result = useMemo((): PanelGeometryResult => {
    const outlineGeometry = createOutlineGeometry();
    
    if (highFidelity) {
      if (isLoading) {
        return {
          geometry: createSimplePanelGeometry(),
          outlineGeometry,
          isHighFidelity: false,
          isLoading: true,
          error: null,
          source: 'simple',
        };
      }
      
      if (realGeometry) {
        return {
          geometry: realGeometry,
          outlineGeometry,
          isHighFidelity: true,
          isLoading: false,
          error,
          source,
        };
      }
      
      // Fallback while loading
      return {
        geometry: createDetailedPanelGeometry(),
        outlineGeometry,
        isHighFidelity: true,
        isLoading: false,
        error: error || 'Loading...',
        source: 'procedural',
      };
    }
    
    return {
      geometry: createSimplePanelGeometry(),
      outlineGeometry,
      isHighFidelity: false,
      isLoading: false,
      error: null,
      source: 'simple',
    };
  }, [highFidelity, realGeometry, isLoading, error, source]);
  
  return result;
}

export default usePanelGeometry;
