/**
 * STEP to GLB Converter Script
 * 
 * This script converts STEP files to GLB format using occt-import-js.
 * 
 * Usage: npx ts-node tools/convert-step-to-glb.ts
 * 
 * NOTE: This requires Node.js environment with occt-import-js installed.
 * The converted GLB will be saved to public/assets/panels/1200_b26.glb
 */

import * as fs from 'fs';
import * as path from 'path';

// Check if GLB already exists
const OUTPUT_PATH = path.resolve(__dirname, '../public/assets/panels/1200_b26.glb');
const INPUT_PATH = path.resolve(__dirname, '../public/assets/panels/1200_b26.step');

async function convertStepToGlb() {
  console.log('[STEP→GLB] Starting conversion...');
  console.log('[STEP→GLB] Input:', INPUT_PATH);
  console.log('[STEP→GLB] Output:', OUTPUT_PATH);
  
  // Check if output already exists
  if (fs.existsSync(OUTPUT_PATH)) {
    console.log('[STEP→GLB] GLB already exists, skipping conversion.');
    return;
  }
  
  // Check if input exists
  if (!fs.existsSync(INPUT_PATH)) {
    console.error('[STEP→GLB] ERROR: Input STEP file not found:', INPUT_PATH);
    process.exit(1);
  }
  
  try {
    // Dynamic import for occt-import-js (ESM module)
    const occtModule = await import('occt-import-js');
    const occt = await occtModule.default();
    
    // Read STEP file
    const stepFileBuffer = fs.readFileSync(INPUT_PATH);
    const stepFileArray = new Uint8Array(stepFileBuffer);
    
    // Import STEP
    console.log('[STEP→GLB] Parsing STEP file...');
    const result = occt.ReadStepFile(stepFileArray, null);
    
    if (!result.success) {
      console.error('[STEP→GLB] Failed to parse STEP file');
      process.exit(1);
    }
    
    console.log('[STEP→GLB] STEP parsed successfully');
    console.log('[STEP→GLB] Meshes found:', result.meshes.length);
    
    // Create GLB structure
    const gltf = createGLTFFromOCCT(result);
    
    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Write GLB file
    fs.writeFileSync(OUTPUT_PATH, Buffer.from(gltf));
    console.log('[STEP→GLB] GLB saved successfully to:', OUTPUT_PATH);
    
  } catch (error) {
    console.error('[STEP→GLB] Conversion error:', error);
    process.exit(1);
  }
}

/**
 * Creates a GLB buffer from OCCT import result
 */
function createGLTFFromOCCT(occtResult: any): ArrayBuffer {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  
  let indexOffset = 0;
  
  // Process each mesh from OCCT result
  for (const mesh of occtResult.meshes) {
    // Add positions (scale from mm to meters: * 0.001)
    const SCALE = 0.001;
    for (let i = 0; i < mesh.attributes.position.array.length; i += 3) {
      positions.push(
        mesh.attributes.position.array[i] * SCALE,
        mesh.attributes.position.array[i + 1] * SCALE,
        mesh.attributes.position.array[i + 2] * SCALE
      );
    }
    
    // Add normals
    if (mesh.attributes.normal) {
      for (let i = 0; i < mesh.attributes.normal.array.length; i++) {
        normals.push(mesh.attributes.normal.array[i]);
      }
    }
    
    // Add indices
    if (mesh.index) {
      for (let i = 0; i < mesh.index.array.length; i++) {
        indices.push(mesh.index.array[i] + indexOffset);
      }
    }
    
    indexOffset += mesh.attributes.position.array.length / 3;
  }
  
  // Center the geometry
  const bbox = calculateBoundingBox(positions);
  const center = [
    (bbox.min[0] + bbox.max[0]) / 2,
    (bbox.min[1] + bbox.max[1]) / 2,
    (bbox.min[2] + bbox.max[2]) / 2,
  ];
  
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= center[0];
    positions[i + 1] -= center[1];
    positions[i + 2] -= center[2];
  }
  
  // Create GLB binary
  return encodeGLB(positions, normals, indices);
}

function calculateBoundingBox(positions: number[]): { min: number[], max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  
  return { min, max };
}

/**
 * Encodes geometry data into a GLB binary buffer
 */
function encodeGLB(positions: number[], normals: number[], indices: number[]): ArrayBuffer {
  // Create buffers
  const positionsBuffer = new Float32Array(positions);
  const normalsBuffer = normals.length > 0 ? new Float32Array(normals) : null;
  const indicesBuffer = indices.length > 0 ? new Uint32Array(indices) : null;
  
  // Calculate buffer sizes
  const positionsBytes = positionsBuffer.byteLength;
  const normalsBytes = normalsBuffer ? normalsBuffer.byteLength : 0;
  const indicesBytes = indicesBuffer ? indicesBuffer.byteLength : 0;
  
  const bufferByteLength = positionsBytes + normalsBytes + indicesBytes;
  
  // Build accessors
  const accessors: any[] = [];
  const bufferViews: any[] = [];
  let byteOffset = 0;
  
  // Positions accessor
  accessors.push({
    bufferView: 0,
    componentType: 5126, // FLOAT
    count: positions.length / 3,
    type: 'VEC3',
    max: calculateBoundingBox(positions).max,
    min: calculateBoundingBox(positions).min,
  });
  bufferViews.push({
    buffer: 0,
    byteOffset: byteOffset,
    byteLength: positionsBytes,
    target: 34962, // ARRAY_BUFFER
  });
  byteOffset += positionsBytes;
  
  // Normals accessor
  if (normalsBuffer) {
    accessors.push({
      bufferView: 1,
      componentType: 5126, // FLOAT
      count: normals.length / 3,
      type: 'VEC3',
    });
    bufferViews.push({
      buffer: 0,
      byteOffset: byteOffset,
      byteLength: normalsBytes,
      target: 34962,
    });
    byteOffset += normalsBytes;
  }
  
  // Indices accessor
  let indicesAccessorIndex: number | undefined;
  if (indicesBuffer) {
    indicesAccessorIndex = accessors.length;
    accessors.push({
      bufferView: bufferViews.length,
      componentType: 5125, // UNSIGNED_INT
      count: indices.length,
      type: 'SCALAR',
    });
    bufferViews.push({
      buffer: 0,
      byteOffset: byteOffset,
      byteLength: indicesBytes,
      target: 34963, // ELEMENT_ARRAY_BUFFER
    });
  }
  
  // Build primitive
  const primitive: any = {
    attributes: {
      POSITION: 0,
    },
    mode: 4, // TRIANGLES
  };
  
  if (normalsBuffer) {
    primitive.attributes.NORMAL = 1;
  }
  
  if (indicesAccessorIndex !== undefined) {
    primitive.indices = indicesAccessorIndex;
  }
  
  // Build GLTF JSON
  const gltfJson = {
    asset: {
      version: '2.0',
      generator: 'OMNI ICF STEP Converter',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bufferByteLength }],
  };
  
  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuffer = new TextEncoder().encode(jsonStr);
  
  // Pad JSON to 4-byte alignment
  const jsonPadding = (4 - (jsonBuffer.byteLength % 4)) % 4;
  const paddedJsonLength = jsonBuffer.byteLength + jsonPadding;
  
  // Pad binary to 4-byte alignment
  const binPadding = (4 - (bufferByteLength % 4)) % 4;
  const paddedBinLength = bufferByteLength + binPadding;
  
  // Calculate total GLB size
  const glbLength = 12 + 8 + paddedJsonLength + 8 + paddedBinLength;
  
  // Create GLB buffer
  const glbBuffer = new ArrayBuffer(glbLength);
  const glbView = new DataView(glbBuffer);
  const glbArray = new Uint8Array(glbBuffer);
  
  let offset = 0;
  
  // GLB header
  glbView.setUint32(offset, 0x46546C67, true); offset += 4; // magic: "glTF"
  glbView.setUint32(offset, 2, true); offset += 4; // version: 2
  glbView.setUint32(offset, glbLength, true); offset += 4; // length
  
  // JSON chunk
  glbView.setUint32(offset, paddedJsonLength, true); offset += 4;
  glbView.setUint32(offset, 0x4E4F534A, true); offset += 4; // type: "JSON"
  glbArray.set(jsonBuffer, offset); offset += jsonBuffer.byteLength;
  for (let i = 0; i < jsonPadding; i++) {
    glbArray[offset++] = 0x20; // space padding
  }
  
  // Binary chunk
  glbView.setUint32(offset, paddedBinLength, true); offset += 4;
  glbView.setUint32(offset, 0x004E4942, true); offset += 4; // type: "BIN"
  
  glbArray.set(new Uint8Array(positionsBuffer.buffer), offset);
  offset += positionsBytes;
  
  if (normalsBuffer) {
    glbArray.set(new Uint8Array(normalsBuffer.buffer), offset);
    offset += normalsBytes;
  }
  
  if (indicesBuffer) {
    glbArray.set(new Uint8Array(indicesBuffer.buffer), offset);
  }
  
  return glbBuffer;
}

// Run the conversion
convertStepToGlb().catch(console.error);
