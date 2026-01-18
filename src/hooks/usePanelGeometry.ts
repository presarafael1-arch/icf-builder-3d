import { useMemo, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { 
  loadSTEPFromURL, 
  loadCachedGeometry, 
  cacheGeometry 
} from '@/lib/step-to-glb-client';
import { PANEL_WIDTH, PANEL_HEIGHT, TOOTH } from '@/types/icf';

// Panel dimensions (mm) - imported from icf.ts for consistency
const PANEL_WIDTH_MM = PANEL_WIDTH; // 1200mm
const PANEL_HEIGHT_MM = PANEL_HEIGHT; // 400mm
const PANEL_THICKNESS_MM = TOOTH; // 1200/17 ≈ 70.59mm (exactly 1 TOOTH)

// Scale factor: mm to meters (3D units)
const SCALE = 0.001;

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

// Target dimensions in METERS
const TARGET_WIDTH_M = PANEL_WIDTH_MM * SCALE;  // 1.2m
const TARGET_HEIGHT_M = PANEL_HEIGHT_MM * SCALE; // 0.4m
const TARGET_THICKNESS_M = PANEL_THICKNESS_MM * SCALE; // ~0.07m

/**
 * Create simple BoxGeometry - THE DEFAULT and most reliable
 * All dimensions in meters, centered pivot
 */
function createSimplePanelGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(TARGET_WIDTH_M, TARGET_HEIGHT_M, TARGET_THICKNESS_M);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Create outline geometry for wireframe rendering
 * Slightly larger than panel for visibility, uses BoxGeometry for wireframe mode
 */
function createOutlineGeometry(): THREE.BufferGeometry {
  const OUTLINE_OFFSET = 0.003; // 3mm offset for visibility
  const geo = new THREE.BoxGeometry(
    TARGET_WIDTH_M + OUTLINE_OFFSET,
    TARGET_HEIGHT_M + OUTLINE_OFFSET,
    TARGET_THICKNESS_M + OUTLINE_OFFSET
  );
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function getBBoxSizeM(geometry: THREE.BufferGeometry): { x: number; y: number; z: number } {
  geometry.computeBoundingBox();
  if (!geometry.boundingBox) return { x: 0, y: 0, z: 0 };
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  return { x: size.x, y: size.y, z: size.z };
}

/**
 * Normalize geometry to target panel size (1.2m x 0.4m x ~0.07m)
 * Centers pivot and applies scale correction
 */
function normalizeGeometryToPanel(geometry: THREE.BufferGeometry): { 
  geometry: THREE.BufferGeometry; 
  bboxSizeM: { x: number; y: number; z: number }; 
  scaleApplied: number 
} {
  const g = geometry.clone();

  // Center pivot
  g.computeBoundingBox();
  if (g.boundingBox) {
    const center = new THREE.Vector3();
    g.boundingBox.getCenter(center);
    g.translate(-center.x, -center.y, -center.z);
  }

  // Get current size
  const sizeBefore = getBBoxSizeM(g);
  const maxDim = Math.max(sizeBefore.x, sizeBefore.y, sizeBefore.z);

  let scaleApplied = 1;

  // Auto-scale if way off target (fail-safe)
  if (maxDim > 0) {
    // If geometry seems to be in mm (very large) or in wrong units
    if (maxDim > 5) {
      // Probably in mm, scale down
      scaleApplied = TARGET_WIDTH_M / maxDim;
      g.scale(scaleApplied, scaleApplied, scaleApplied);
    } else if (maxDim < 0.2) {
      // Too small, scale up to target
      scaleApplied = TARGET_WIDTH_M / maxDim;
      g.scale(scaleApplied, scaleApplied, scaleApplied);
    } else {
      // Within reasonable range, normalize to exact target
      const ratio = TARGET_WIDTH_M / maxDim;
      if (Math.abs(1 - ratio) > 0.05) {
        scaleApplied = ratio;
        g.scale(scaleApplied, scaleApplied, scaleApplied);
      }
    }
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
 * Hook that provides panel geometry with robust fallback
 * 
 * PRIORITY ORDER:
 * 1. simple (BoxGeometry) - DEFAULT, always works
 * 2. glb (pre-converted) - if highFidelity ON and file exists
 * 3. step (runtime WASM) - if highFidelity ON and GLB unavailable
 * 4. procedural fallback - never used now, kept for compatibility
 * 
 * CRITICAL: Never return invalid/null geometry. Always fallback to simple.
 */
export function usePanelGeometry(highFidelity: boolean = false): PanelGeometryResult {
  const [realGeometry, setRealGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<PanelGeometryResult['source']>('simple');
  const [meta, setMeta] = useState<{ bboxSizeM: { x: number; y: number; z: number }; scaleApplied: number }>({
    bboxSizeM: { x: TARGET_WIDTH_M, y: TARGET_HEIGHT_M, z: TARGET_THICKNESS_M },
    scaleApplied: 1,
  });

  // Always have simple geometry ready as fallback
  const simpleGeometry = useMemo(() => createSimplePanelGeometry(), []);
  const outlineGeometry = useMemo(() => createOutlineGeometry(), []);

  const loadRealGeometry = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // 1) Check cache first
      const cached = loadCachedGeometry();
      if (cached && isGeometryValid(cached)) {
        const normalized = normalizeGeometryToPanel(cached);
        setRealGeometry(normalized.geometry);
        setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
        setSource('cache');
        setIsLoading(false);
        console.log('[usePanelGeometry] Loaded from cache');
        return;
      }

      // 2) Try pre-built GLB
      const glbRaw = await loadGLBGeometry('/assets/panels/1200_b26.glb');
      if (glbRaw && isGeometryValid(glbRaw)) {
        const normalized = normalizeGeometryToPanel(glbRaw);
        setRealGeometry(normalized.geometry);
        setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
        setSource('glb');
        cacheGeometry(normalized.geometry);
        setIsLoading(false);
        console.log('[usePanelGeometry] Loaded GLB successfully');
        return;
      }

      // 3) Try STEP conversion (may fail on some browsers)
      try {
        const stepRaw = await loadSTEPFromURL('/assets/panels/1200_b26.step');
        if (isGeometryValid(stepRaw)) {
          const normalized = normalizeGeometryToPanel(stepRaw);
          setRealGeometry(normalized.geometry);
          setMeta({ bboxSizeM: normalized.bboxSizeM, scaleApplied: normalized.scaleApplied });
          setSource('step');
          cacheGeometry(normalized.geometry);
          setIsLoading(false);
          console.log('[usePanelGeometry] Loaded STEP via WASM');
          return;
        }
      } catch (stepError) {
        console.warn('[usePanelGeometry] STEP conversion failed:', stepError);
      }

      // 4) Fallback: high fidelity requested but unavailable
      setRealGeometry(null);
      setSource('simple');
      setError('High fidelity geometry unavailable - using simple boxes');
      console.warn('[usePanelGeometry] High fidelity unavailable, using simple');
    } catch (err) {
      console.error('[usePanelGeometry] Error loading geometry:', err);
      setRealGeometry(null);
      setSource('simple');
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (highFidelity) {
      loadRealGeometry();
    } else {
      // Reset to simple mode
      setRealGeometry(null);
      setMeta({ bboxSizeM: { x: TARGET_WIDTH_M, y: TARGET_HEIGHT_M, z: TARGET_THICKNESS_M }, scaleApplied: 1 });
      setSource('simple');
      setError(null);
      setIsLoading(false);
    }
  }, [highFidelity, loadRealGeometry]);

  // Compute final result - ALWAYS return valid geometry
  const result = useMemo((): PanelGeometryResult => {
    // Default: simple geometry (ALWAYS WORKS)
    const defaultResult: PanelGeometryResult = {
      geometry: simpleGeometry,
      outlineGeometry,
      isHighFidelity: false,
      isLoading: false,
      error: null,
      source: 'simple',
      bboxSizeM: { x: TARGET_WIDTH_M, y: TARGET_HEIGHT_M, z: TARGET_THICKNESS_M },
      scaleApplied: 1,
      geometryValid: true,
    };

    // If not high fidelity mode, return simple
    if (!highFidelity) {
      return defaultResult;
    }

    // If loading, still show simple geometry (don't hide panels!)
    if (isLoading) {
      return {
        ...defaultResult,
        isLoading: true,
        source: 'simple',
      };
    }

    // If high fidelity loaded successfully
    if (realGeometry && isGeometryValid(realGeometry)) {
      return {
        geometry: realGeometry,
        outlineGeometry,
        isHighFidelity: true,
        isLoading: false,
        error,
        source,
        bboxSizeM: meta.bboxSizeM,
        scaleApplied: meta.scaleApplied,
        geometryValid: true,
      };
    }

    // High fidelity failed - fallback to simple with error message
    return {
      ...defaultResult,
      error: error || 'High fidelity unavailable',
      source: 'simple',
    };
  }, [highFidelity, realGeometry, isLoading, error, source, meta, simpleGeometry, outlineGeometry]);

  return result;
}

export default usePanelGeometry;
