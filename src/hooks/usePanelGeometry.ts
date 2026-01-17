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
  bboxSizeM: { x: number; y: number; z: number };
  scaleApplied: number;
  geometryValid: boolean;
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
        // Find the first mesh in the scene
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry && !geometry) {
            geometry = child.geometry.clone();
          }
        });
        resolve(geometry);
      },
      undefined,
      () => resolve(null)
    );
  });
}

function getBBoxSizeM(geometry: THREE.BufferGeometry): { x: number; y: number; z: number } {
  geometry.computeBoundingBox();
  if (!geometry.boundingBox) return { x: 0, y: 0, z: 0 };
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  return { x: size.x, y: size.y, z: size.z };
}

/**
 * Normalize units + pivot + scale to the real panel size.
 *
 * Rule: instances are in meters, geometry must be in meters too.
 * This function ensures geometry bbox matches ~1.2m x 0.4m within tolerance.
 */
function normalizeGeometryToPanel(geometry: THREE.BufferGeometry): { geometry: THREE.BufferGeometry; bboxSizeM: { x: number; y: number; z: number }; scaleApplied: number } {
  const g = geometry.clone();

  // Center pivot
  g.computeBoundingBox();
  if (g.boundingBox) {
    const center = new THREE.Vector3();
    g.boundingBox.getCenter(center);
    g.translate(-center.x, -center.y, -center.z);
  }

  // Fail-safe scale normalization
  const targetW = PANEL_WIDTH_MM * SCALE;  // 1.2m
  const targetH = PANEL_HEIGHT_MM * SCALE; // 0.4m

  const sizeBefore = getBBoxSizeM(g);
  const dimMax = Math.max(sizeBefore.x, sizeBefore.y, sizeBefore.z);

  let scaleApplied = 1;

  // Heuristic (user requirement)
  // too small (m treated as mm) -> scale up
  // too large (mm treated as m) -> scale down
  const widthLike = dimMax; // robust even if axes differ

  if (widthLike > 0) {
    if (widthLike < 0.2 || widthLike > 5) {
      // Bring biggest dimension to target width
      scaleApplied = targetW / widthLike;
      g.scale(scaleApplied, scaleApplied, scaleApplied);
    } else {
      // Within sane range, but still normalize to expected panel size (±5%)
      const ratioToTarget = targetW / widthLike;
      if (Math.abs(1 - ratioToTarget) > 0.05) {
        scaleApplied = ratioToTarget;
        g.scale(scaleApplied, scaleApplied, scaleApplied);
      }
    }
  }

  // Optional: ensure height roughly matches too (secondary correction)
  const sizeAfter = getBBoxSizeM(g);
  const heightLike = Math.min(Math.max(sizeAfter.x, sizeAfter.y), Math.max(sizeAfter.y, sizeAfter.z));
  if (heightLike > 0 && Math.abs(1 - (targetH / heightLike)) > 0.25) {
    // keep uniform scale only; just log mismatch via HUD
  }

  g.computeVertexNormals();
  g.computeBoundingSphere();

  return { geometry: g, bboxSizeM: getBBoxSizeM(g), scaleApplied };
}

function isGeometryValid(geometry: THREE.BufferGeometry | null | undefined): boolean {
  if (!geometry) return false;
  const pos = geometry.getAttribute('position');
  return !!pos && pos.count > 0;
}

/**
 * Hook that provides panel geometry with real STEP/GLB loading
 */
export function usePanelGeometry(highFidelity: boolean = false): PanelGeometryResult {
  const [realGeometry, setRealGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<PanelGeometryResult['source']>('simple');
  const [meta, setMeta] = useState<{ bboxSizeM: { x: number; y: number; z: number }; scaleApplied: number }>({
    bboxSizeM: { x: 0, y: 0, z: 0 },
    scaleApplied: 1,
  });
  
  const loadRealGeometry = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // 1) cache
      const cached = loadCachedGeometry();
      if (cached && isGeometryValid(cached)) {
        const normalized = normalizeGeometryToPanel(cached);
        setRealGeometry(normalized.geometry);
        setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
        setSource('cache');
        setIsLoading(false);
        return;
      }

      // 2) prebuilt GLB
      const glbRaw = await loadGLBGeometry('/assets/panels/1200_b26.glb');
      if (glbRaw && isGeometryValid(glbRaw)) {
        const normalized = normalizeGeometryToPanel(glbRaw);
        setRealGeometry(normalized.geometry);
        setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
        setSource('glb');
        cacheGeometry(normalized.geometry);
        setIsLoading(false);
        return;
      }

      // 3) STEP→geometry (WASM)
      try {
        const stepRaw = await loadSTEPFromURL('/assets/panels/1200_b26.step');
        if (isGeometryValid(stepRaw)) {
          const normalized = normalizeGeometryToPanel(stepRaw);
          setRealGeometry(normalized.geometry);
          setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
          setSource('step');
          cacheGeometry(normalized.geometry);
          setIsLoading(false);
          return;
        }
      } catch (stepError) {
        console.warn('[usePanelGeometry] STEP conversion failed:', stepError);
      }

      // 4) procedural fallback (always valid)
      const procedural = createDetailedPanelGeometry();
      const normalized = normalizeGeometryToPanel(procedural);
      setRealGeometry(normalized.geometry);
      setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
      setSource('procedural');
      setError('Real geometry unavailable, using procedural');
    } catch (err) {
      console.error('[usePanelGeometry] Error loading geometry:', err);
      const procedural = createDetailedPanelGeometry();
      const normalized = normalizeGeometryToPanel(procedural);
      setRealGeometry(normalized.geometry);
      setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
      setSource('procedural');
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (highFidelity) {
      loadRealGeometry();
    } else {
      setRealGeometry(null);
      setMeta({ bboxSizeM: { x: 0, y: 0, z: 0 }, scaleApplied: 1 });
      setSource('simple');
      setError(null);
    }
  }, [highFidelity, loadRealGeometry]);
  
  const result = useMemo((): PanelGeometryResult => {
    const outlineGeometry = createOutlineGeometry();

    // Always have a valid fallback geometry (procedural) to avoid blank panels during async loading
    const proceduralFallback = normalizeGeometryToPanel(createDetailedPanelGeometry());

    if (highFidelity) {
      // While loading, never hide panels: use procedural fallback
      if (isLoading) {
        return {
          geometry: proceduralFallback.geometry,
          outlineGeometry,
          isHighFidelity: false,
          isLoading: true,
          error: null,
          source: 'procedural',
          bboxSizeM: proceduralFallback.bboxSizeM,
          scaleApplied: proceduralFallback.scaleApplied,
          geometryValid: true,
        };
      }

      if (realGeometry && isGeometryValid(realGeometry)) {
        const bboxSizeM = meta.bboxSizeM;
        const scaleApplied = meta.scaleApplied;
        return {
          geometry: realGeometry,
          outlineGeometry,
          isHighFidelity: true,
          isLoading: false,
          error,
          source,
          bboxSizeM,
          scaleApplied,
          geometryValid: true,
        };
      }

      // If real geometry failed, still show procedural
      return {
        geometry: proceduralFallback.geometry,
        outlineGeometry,
        isHighFidelity: false,
        isLoading: false,
        error: error || 'Real geometry unavailable',
        source: 'procedural',
        bboxSizeM: proceduralFallback.bboxSizeM,
        scaleApplied: proceduralFallback.scaleApplied,
        geometryValid: true,
      };
    }

    // Low fidelity: simple box (already meters)
    const simple = createSimplePanelGeometry();
    const normalizedSimple = normalizeGeometryToPanel(simple);

    return {
      geometry: normalizedSimple.geometry,
      outlineGeometry,
      isHighFidelity: false,
      isLoading: false,
      error: null,
      source: 'simple',
      bboxSizeM: normalizedSimple.bboxSizeM,
      scaleApplied: normalizedSimple.scaleApplied,
      geometryValid: true,
    };
  }, [highFidelity, realGeometry, isLoading, error, source, meta]);
  
  return result;
}

export default usePanelGeometry;
