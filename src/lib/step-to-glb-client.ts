/**
 * Client-side STEP to GLB converter using occt-import-js
 * 
 * This module provides a way to convert STEP files directly in the browser
 * and cache the result for future use.
 */

import * as THREE from 'three';

// Panel dimensions for normalization
const PANEL_WIDTH_MM = 1200;
const PANEL_HEIGHT_MM = 400;
const SCALE = 0.001; // mm to meters

interface OCCTResult {
  success: boolean;
  meshes: Array<{
    attributes: {
      position: { array: Float32Array };
      normal?: { array: Float32Array };
    };
    index?: { array: Uint32Array | Uint16Array };
  }>;
}

let occtInstance: any = null;
let loadingPromise: Promise<any> | null = null;

/**
 * Initialize OCCT (lazy load)
 */
async function initOCCT(): Promise<any> {
  if (occtInstance) return occtInstance;
  
  if (loadingPromise) return loadingPromise;
  
  loadingPromise = (async () => {
    try {
      // @ts-ignore - occt-import-js is a WASM module
      const occtModule = await import('occt-import-js');
      occtInstance = await occtModule.default();
      console.log('[OCCT] Initialized successfully');
      return occtInstance;
    } catch (error) {
      console.error('[OCCT] Failed to initialize:', error);
      throw error;
    }
  })();
  
  return loadingPromise;
}

/**
 * Convert STEP file data to Three.js BufferGeometry
 */
export async function convertSTEPToGeometry(stepData: ArrayBuffer): Promise<THREE.BufferGeometry> {
  const occt = await initOCCT();
  
  const stepArray = new Uint8Array(stepData);
  console.log('[STEP→Geometry] Parsing STEP file, size:', stepArray.length, 'bytes');
  
  const result: OCCTResult = occt.ReadStepFile(stepArray, null);
  
  if (!result.success) {
    throw new Error('Failed to parse STEP file');
  }
  
  console.log('[STEP→Geometry] Meshes found:', result.meshes.length);
  
  // Merge all meshes into one geometry
  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allIndices: number[] = [];
  let indexOffset = 0;
  
  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array;
    const normals = mesh.attributes.normal?.array;
    const indices = mesh.index?.array;
    
    // Add positions (scale from mm to meters)
    for (let i = 0; i < positions.length; i += 3) {
      allPositions.push(
        positions[i] * SCALE,
        positions[i + 1] * SCALE,
        positions[i + 2] * SCALE
      );
    }
    
    // Add normals
    if (normals) {
      for (let i = 0; i < normals.length; i++) {
        allNormals.push(normals[i]);
      }
    }
    
    // Add indices
    if (indices) {
      for (let i = 0; i < indices.length; i++) {
        allIndices.push(indices[i] + indexOffset);
      }
    }
    
    indexOffset += positions.length / 3;
  }
  
  // Create BufferGeometry
  const geometry = new THREE.BufferGeometry();
  
  const positionsArray = new Float32Array(allPositions);
  geometry.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3));
  
  if (allNormals.length > 0) {
    const normalsArray = new Float32Array(allNormals);
    geometry.setAttribute('normal', new THREE.BufferAttribute(normalsArray, 3));
  }
  
  if (allIndices.length > 0) {
    const indicesArray = new Uint32Array(allIndices);
    geometry.setIndex(new THREE.BufferAttribute(indicesArray, 1));
  }
  
  // Center and normalize the geometry
  geometry.computeBoundingBox();
  
  if (geometry.boundingBox) {
    const bbox = geometry.boundingBox;
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    
    // Center the geometry
    geometry.translate(-center.x, -center.y, -center.z);
    
    // Calculate and apply scale to match expected panel dimensions
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    
    // Find the dimension that corresponds to panel width (1200mm = 1.2m)
    const targetWidth = PANEL_WIDTH_MM * SCALE;
    const maxDim = Math.max(size.x, size.y, size.z);
    
    if (maxDim > 0 && Math.abs(maxDim - targetWidth) > 0.01) {
      const scaleFactor = targetWidth / maxDim;
      geometry.scale(scaleFactor, scaleFactor, scaleFactor);
    }
  }
  
  // Compute normals if not provided
  if (allNormals.length === 0) {
    geometry.computeVertexNormals();
  }
  
  geometry.computeBoundingSphere();
  
  console.log('[STEP→Geometry] Conversion complete');
  
  return geometry;
}

/**
 * Fetch and convert the STEP file from URL
 */
export async function loadSTEPFromURL(url: string): Promise<THREE.BufferGeometry> {
  console.log('[STEP] Loading from URL:', url);
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch STEP file: ${response.status}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  return convertSTEPToGeometry(arrayBuffer);
}

/**
 * Cache key for localStorage
 */
const CACHE_KEY = 'omni_icf_panel_glb_cache';

/**
 * Save geometry to cache (as serialized buffer)
 */
export function cacheGeometry(geometry: THREE.BufferGeometry): void {
  try {
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal')?.array;
    const index = geometry.index?.array;
    
    const cache = {
      positions: Array.from(positions as Float32Array),
      normals: normals ? Array.from(normals as Float32Array) : null,
      index: index ? Array.from(index as Uint32Array) : null,
      timestamp: Date.now(),
    };
    
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    console.log('[Cache] Geometry cached successfully');
  } catch (error) {
    console.warn('[Cache] Failed to cache geometry:', error);
  }
}

/**
 * Load geometry from cache
 */
export function loadCachedGeometry(): THREE.BufferGeometry | null {
  try {
    const cacheStr = localStorage.getItem(CACHE_KEY);
    if (!cacheStr) return null;
    
    const cache = JSON.parse(cacheStr);
    
    // Check if cache is older than 7 days
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - cache.timestamp > maxAge) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    
    const geometry = new THREE.BufferGeometry();
    
    const positions = new Float32Array(cache.positions);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    if (cache.normals) {
      const normals = new Float32Array(cache.normals);
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    }
    
    if (cache.index) {
      const index = new Uint32Array(cache.index);
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
    }
    
    geometry.computeBoundingSphere();
    
    console.log('[Cache] Geometry loaded from cache');
    return geometry;
  } catch (error) {
    console.warn('[Cache] Failed to load cached geometry:', error);
    return null;
  }
}
