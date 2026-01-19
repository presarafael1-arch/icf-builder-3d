/**
 * Debug Visualizations for Panel Layout
 * 
 * Shows:
 * - Seeds (node markers) at L/T/X junctions
 * - T-junction axes
 * - Run segments with different colors
 * - Middle zone where orange cuts are allowed
 * - Index from seed overlay
 * - Wall dimensions in TOOTH units
 */

import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { WallChain, ChainNode, ChainsResult } from '@/lib/wall-chains';
import { 
  detectLJunctions, 
  detectTJunctions, 
  LJunctionInfo, 
  TJunctionInfo 
} from '@/lib/panel-layout';
import { 
  PANEL_HEIGHT, 
  ViewerSettings, 
  TOOTH, 
  FOAM_THICKNESS,
  getWallTotalThickness,
  getConcreteThicknessMm
} from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

// Run colors for different chain segments
const RUN_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#96CEB4', // Green
  '#FFEAA7', // Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Gold
  '#BB8FCE', // Purple
  '#85C1E9', // Light Blue
];

interface DebugVisualizationsProps {
  chainsResult: ChainsResult;
  settings: ViewerSettings;
  onSettingsChange?: (settings: ViewerSettings) => void;
  selectedCornerNode?: string | null; // Full node ID: 'node-{junctionId}-ext' or 'node-{junctionId}-int'
  onSelectCornerNode?: (nodeId: string | null) => void;
  cornerNodeOffsets?: Map<string, { nodeId: string; offsetX: number; offsetY: number }>; // Individual offsets per node
}

// Seed markers at junction nodes
function SeedMarkers({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  
  // Detect junctions
  const lJunctions = useMemo(() => detectLJunctions(chains, settings.concreteThickness), [chains, settings.concreteThickness]);
  const tJunctions = useMemo(() => detectTJunctions(chains), [chains]);
  
  // Combine all junction positions
  const seeds = useMemo(() => {
    const result: { x: number; y: number; type: 'L' | 'T' | 'X' | 'end'; id: string }[] = [];
    
    lJunctions.forEach(lj => {
      result.push({ x: lj.x, y: lj.y, type: 'L', id: lj.nodeId });
    });
    
    tJunctions.forEach(tj => {
      result.push({ x: tj.x, y: tj.y, type: 'T', id: tj.nodeId });
    });
    
    // Detect free ends (degree-1 nodes)
    const nodeConnections = new Map<string, number>();
    const nodePositions = new Map<string, { x: number; y: number }>();
    const SNAP_TOL = 20;
    
    const getNodeKey = (x: number, y: number) => {
      const rx = Math.round(x / SNAP_TOL) * SNAP_TOL;
      const ry = Math.round(y / SNAP_TOL) * SNAP_TOL;
      return `${rx},${ry}`;
    };
    
    chains.forEach(chain => {
      const startKey = getNodeKey(chain.startX, chain.startY);
      const endKey = getNodeKey(chain.endX, chain.endY);
      
      nodeConnections.set(startKey, (nodeConnections.get(startKey) || 0) + 1);
      nodeConnections.set(endKey, (nodeConnections.get(endKey) || 0) + 1);
      
      nodePositions.set(startKey, { x: chain.startX, y: chain.startY });
      nodePositions.set(endKey, { x: chain.endX, y: chain.endY });
    });
    
    nodeConnections.forEach((count, key) => {
      if (count === 1) {
        const pos = nodePositions.get(key)!;
        // Check if this isn't already an L or T junction
        const isLJunction = lJunctions.some(lj => {
          const ljKey = getNodeKey(lj.x, lj.y);
          return ljKey === key;
        });
        const isTJunction = tJunctions.some(tj => {
          const tjKey = getNodeKey(tj.x, tj.y);
          return tjKey === key;
        });
        
        if (!isLJunction && !isTJunction) {
          result.push({ x: pos.x, y: pos.y, type: 'end', id: `end-${key}` });
        }
      }
    });
    
    return result;
  }, [lJunctions, tJunctions, chains]);
  
  // Create sphere geometry for markers
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.15, 16, 16), []);
  
  const getColor = (type: 'L' | 'T' | 'X' | 'end') => {
    switch (type) {
      case 'L': return '#FF4444'; // Red for L-corners
      case 'T': return '#44FF44'; // Green for T-junctions
      case 'X': return '#4444FF'; // Blue for X-junctions
      case 'end': return '#FFAA00'; // Orange for free ends
    }
  };
  
  const y = settings.maxRows * PANEL_HEIGHT * SCALE + 0.3; // Slightly above walls
  
  return (
    <group>
      {seeds.map((seed, i) => (
        <group key={seed.id} position={[seed.x * SCALE, y, seed.y * SCALE]}>
          <mesh geometry={sphereGeometry}>
            <meshStandardMaterial 
              color={getColor(seed.type)} 
              emissive={getColor(seed.type)}
              emissiveIntensity={0.5}
            />
          </mesh>
          <Html
            center
            distanceFactor={10}
            style={{
              color: '#fff',
              fontSize: '10px',
              fontWeight: 'bold',
              background: getColor(seed.type),
              padding: '2px 6px',
              borderRadius: '4px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {seed.type}
          </Html>
        </group>
      ))}
    </group>
  );
}

// Corner nodes visualization - shows exterior and interior intersection points
function CornerNodesVisualization({ chainsResult, settings, selectedCornerNode, onSelectCornerNode, cornerNodeOffsets }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  const showLabels = settings.showCornerNodeLabels ?? true;
  const showWires = settings.showCornerNodeWires ?? true;

  // Detect L-junctions with computed corner nodes
  const lJunctions = useMemo(
    () => detectLJunctions(chains, settings.concreteThickness),
    [chains, settings.concreteThickness]
  );

  // Vertical reference line ("fio") so you can see where the node is in plan
  const yTop = settings.maxRows * PANEL_HEIGHT * SCALE + 0.4;
  const yBase = 0.02;

  const handleNodeClick = (fullNodeId: string, e: any) => {
    e.stopPropagation();
    if (onSelectCornerNode) {
      // Toggle selection using full node ID
      if (selectedCornerNode === fullNodeId) {
        onSelectCornerNode(null);
      } else {
        onSelectCornerNode(fullNodeId);
      }
    }
  };

  return (
    <group>
      {lJunctions.map((lj) => {
        if (!lj.exteriorNode || !lj.interiorNode) return null;

        // Generate full node IDs
        const extNodeId = `node-${lj.nodeId}-ext`;
        const intNodeId = `node-${lj.nodeId}-int`;
        
        // Get individual offsets for each node (in TOOTH units, convert to mm)
        const extOffset = cornerNodeOffsets?.get(extNodeId);
        const intOffset = cornerNodeOffsets?.get(intNodeId);
        const extOffsetX = (extOffset?.offsetX ?? 0) * TOOTH;
        const extOffsetY = (extOffset?.offsetY ?? 0) * TOOTH;
        const intOffsetX = (intOffset?.offsetX ?? 0) * TOOTH;
        const intOffsetY = (intOffset?.offsetY ?? 0) * TOOTH;

        // Apply individual offsets to node positions
        const extNode = {
          ...lj.exteriorNode,
          x: lj.exteriorNode.x + extOffsetX,
          y: lj.exteriorNode.y + extOffsetY,
        };
        const intNode = {
          ...lj.interiorNode,
          x: lj.interiorNode.x + intOffsetX,
          y: lj.interiorNode.y + intOffsetY,
        };
        const dxfPos = [lj.x * SCALE, yBase, lj.y * SCALE] as [number, number, number];
        
        const isExtSelected = selectedCornerNode === extNodeId;
        const isIntSelected = selectedCornerNode === intNodeId;

        return (
          <group key={lj.nodeId}>
            {/* EXTERIOR node */}
            <group>
              {showWires && (
                <line>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={2}
                      array={new Float32Array([
                        extNode.x * SCALE, yBase, extNode.y * SCALE,
                        extNode.x * SCALE, yTop, extNode.y * SCALE,
                      ])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={isExtSelected ? "#FFFFFF" : "#FF0000"} linewidth={isExtSelected ? 3 : 2} />
                </line>
              )}

              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([
                      dxfPos[0], dxfPos[1], dxfPos[2],
                      extNode.x * SCALE, yBase, extNode.y * SCALE,
                    ])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={isExtSelected ? "#FFFFFF" : "#FF0000"} linewidth={2} />
              </line>

              <group position={[extNode.x * SCALE, yTop, extNode.y * SCALE]}>
                {/* Invisible larger hitbox for easier clicking */}
                <mesh 
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(extNodeId, e); }}
                  onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                  onPointerOut={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
                >
                  <sphereGeometry args={[0.25, 16, 16]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
                
                {/* Visible sphere */}
                <mesh>
                  <sphereGeometry args={[isExtSelected ? 0.18 : 0.12, 16, 16]} />
                  <meshStandardMaterial 
                    color={isExtSelected ? "#FFFFFF" : "#FF0000"} 
                    emissive={isExtSelected ? "#FF0000" : "#FF0000"} 
                    emissiveIntensity={isExtSelected ? 1.2 : 0.8} 
                  />
                </mesh>

                {/* Selection ring */}
                {isExtSelected && (
                  <mesh rotation={[Math.PI / 2, 0, 0]}>
                    <ringGeometry args={[0.22, 0.28, 32]} />
                    <meshBasicMaterial color="#FFFFFF" side={2} />
                  </mesh>
                )}

                <line>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={4}
                      array={new Float32Array([
                        -0.15, 0, 0, 0.15, 0, 0,
                        0, 0, -0.15, 0, 0, 0.15,
                      ])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={isExtSelected ? "#FFFFFF" : "#FF0000"} linewidth={2} />
                </line>

                {showLabels && (
                  <Html
                    center
                    distanceFactor={8}
                    style={{
                      color: isExtSelected ? '#FF0000' : '#FFF',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      background: isExtSelected ? '#FFFFFF' : '#FF0000',
                      padding: '3px 8px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap',
                      pointerEvents: 'auto',
                      cursor: 'pointer',
                      border: isExtSelected ? '3px solid #FF0000' : '2px solid white',
                      boxShadow: isExtSelected ? '0 0 10px #FF0000' : 'none',
                    }}
                    onClick={(e) => handleNodeClick(extNodeId, e)}
                  >
                    NÓ EXT {isExtSelected && '✓'}
                  </Html>
                )}
              </group>
            </group>

            {/* INTERIOR node */}
            <group>
              {showWires && (
                <line>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={2}
                      array={new Float32Array([
                        intNode.x * SCALE, yBase, intNode.y * SCALE,
                        intNode.x * SCALE, yTop, intNode.y * SCALE,
                      ])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={isIntSelected ? "#FFFFFF" : "#FFCC00"} linewidth={isIntSelected ? 3 : 2} />
                </line>
              )}

              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([
                      dxfPos[0], dxfPos[1], dxfPos[2],
                      intNode.x * SCALE, yBase, intNode.y * SCALE,
                    ])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={isIntSelected ? "#FFFFFF" : "#FFCC00"} linewidth={2} />
              </line>

              <group position={[intNode.x * SCALE, yTop, intNode.y * SCALE]}>
                {/* Invisible larger hitbox for easier clicking */}
                <mesh 
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(intNodeId, e); }}
                  onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                  onPointerOut={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
                >
                  <sphereGeometry args={[0.25, 16, 16]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
                
                {/* Visible sphere */}
                <mesh>
                  <sphereGeometry args={[isIntSelected ? 0.18 : 0.12, 16, 16]} />
                  <meshStandardMaterial 
                    color={isIntSelected ? "#FFFFFF" : "#FFCC00"} 
                    emissive={isIntSelected ? "#FFCC00" : "#FFCC00"} 
                    emissiveIntensity={isIntSelected ? 1.2 : 0.8} 
                  />
                </mesh>

                {/* Selection ring */}
                {isIntSelected && (
                  <mesh rotation={[Math.PI / 2, 0, 0]}>
                    <ringGeometry args={[0.22, 0.28, 32]} />
                    <meshBasicMaterial color="#FFFFFF" side={2} />
                  </mesh>
                )}

                <line>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={4}
                      array={new Float32Array([
                        -0.15, 0, 0, 0.15, 0, 0,
                        0, 0, -0.15, 0, 0, 0.15,
                      ])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={isIntSelected ? "#FFFFFF" : "#FFCC00"} linewidth={2} />
                </line>

                {showLabels && (
                  <Html
                    center
                    distanceFactor={8}
                    style={{
                      color: isIntSelected ? '#FFCC00' : '#000',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      background: isIntSelected ? '#FFFFFF' : '#FFCC00',
                      padding: '3px 8px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap',
                      pointerEvents: 'auto',
                      cursor: 'pointer',
                      border: isIntSelected ? '3px solid #FFCC00' : '2px solid white',
                      boxShadow: isIntSelected ? '0 0 10px #FFCC00' : 'none',
                    }}
                    onClick={(e) => handleNodeClick(intNodeId, e)}
                  >
                    NÓ INT {isIntSelected && '✓'}
                  </Html>
                )}
              </group>
            </group>

            {/* DXF intersection marker */}
            <mesh position={dxfPos}>
              <sphereGeometry args={[0.06, 8, 8]} />
              <meshBasicMaterial color="#FFFFFF" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// L-junction arrows visualization - shows PRIMARY (exterior) vs SECONDARY (interior) arms
function LJunctionArrows({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  const lJunctions = useMemo(() => detectLJunctions(chains, settings.concreteThickness), [chains, settings.concreteThickness]);
  
  // Get chain by ID
  const chainMap = useMemo(() => {
    const map = new Map<string, typeof chains[0]>();
    chains.forEach(c => map.set(c.id, c));
    return map;
  }, [chains]);
  
  const y = settings.maxRows * PANEL_HEIGHT * SCALE / 2;
  const arrowLength = 1.0; // 1m visual length
  const arrowHeadSize = 0.15;
  
  return (
    <group>
      {lJunctions.map((lj) => {
        const primaryChain = chainMap.get(lj.primaryChainId);
        const secondaryChain = chainMap.get(lj.secondaryChainId);
        if (!primaryChain || !secondaryChain) return null;
        
        // Compute direction vectors pointing OUTWARD from junction
        const getPrimaryDir = () => {
          // Check if junction is at start or end of primary chain
          const distToStart = Math.hypot(lj.x - primaryChain.startX, lj.y - primaryChain.startY);
          const distToEnd = Math.hypot(lj.x - primaryChain.endX, lj.y - primaryChain.endY);
          
          if (distToStart < distToEnd) {
            // Junction is at chain start, arrow points toward end
            return { 
              x: (primaryChain.endX - primaryChain.startX) / primaryChain.lengthMm,
              y: (primaryChain.endY - primaryChain.startY) / primaryChain.lengthMm
            };
          } else {
            // Junction is at chain end, arrow points toward start
            return {
              x: (primaryChain.startX - primaryChain.endX) / primaryChain.lengthMm,
              y: (primaryChain.startY - primaryChain.endY) / primaryChain.lengthMm
            };
          }
        };
        
        const getSecondaryDir = () => {
          const distToStart = Math.hypot(lj.x - secondaryChain.startX, lj.y - secondaryChain.startY);
          const distToEnd = Math.hypot(lj.x - secondaryChain.endX, lj.y - secondaryChain.endY);
          
          if (distToStart < distToEnd) {
            return { 
              x: (secondaryChain.endX - secondaryChain.startX) / secondaryChain.lengthMm,
              y: (secondaryChain.endY - secondaryChain.startY) / secondaryChain.lengthMm
            };
          } else {
            return {
              x: (secondaryChain.startX - secondaryChain.endX) / secondaryChain.lengthMm,
              y: (secondaryChain.startY - secondaryChain.endY) / secondaryChain.lengthMm
            };
          }
        };
        
        const primDir = getPrimaryDir();
        const secDir = getSecondaryDir();
        
        const junctionPos = new THREE.Vector3(lj.x * SCALE, y, lj.y * SCALE);
        
        // Arrow endpoints
        const primEnd = new THREE.Vector3(
          (lj.x + primDir.x * arrowLength * 1000) * SCALE,
          y,
          (lj.y + primDir.y * arrowLength * 1000) * SCALE
        );
        const secEnd = new THREE.Vector3(
          (lj.x + secDir.x * arrowLength * 1000) * SCALE,
          y,
          (lj.y + secDir.y * arrowLength * 1000) * SCALE
        );
        
        // Arrow head geometry helper
        const createArrowHead = (endPos: THREE.Vector3, dir: { x: number; y: number }, color: string) => {
          const angle = Math.atan2(dir.y, dir.x);
          const leftAngle = angle + Math.PI + Math.PI / 6;
          const rightAngle = angle + Math.PI - Math.PI / 6;
          
          const leftPoint = new THREE.Vector3(
            endPos.x + Math.cos(leftAngle) * arrowHeadSize,
            y,
            endPos.z + Math.sin(leftAngle) * arrowHeadSize
          );
          const rightPoint = new THREE.Vector3(
            endPos.x + Math.cos(rightAngle) * arrowHeadSize,
            y,
            endPos.z + Math.sin(rightAngle) * arrowHeadSize
          );
          
          return (
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={4}
                  array={new Float32Array([
                    leftPoint.x, leftPoint.y, leftPoint.z,
                    endPos.x, endPos.y, endPos.z,
                    endPos.x, endPos.y, endPos.z,
                    rightPoint.x, rightPoint.y, rightPoint.z,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color={color} linewidth={2} />
            </line>
          );
        };
        
        return (
          <group key={lj.nodeId}>
            {/* PRIMARY arrow (EXTERIOR) - YELLOW - gets FULL panels on odd rows */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    junctionPos.x, junctionPos.y, junctionPos.z,
                    primEnd.x, primEnd.y, primEnd.z,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#E6D44A" linewidth={3} />
            </line>
            {createArrowHead(primEnd, primDir, '#E6D44A')}
            
            {/* SECONDARY arrow (INTERIOR) - RED - gets CORNER_CUT on odd rows */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    junctionPos.x, junctionPos.y, junctionPos.z,
                    secEnd.x, secEnd.y, secEnd.z,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#C83A3A" linewidth={3} />
            </line>
            {createArrowHead(secEnd, secDir, '#C83A3A')}
            
            {/* Labels */}
            <Html
              position={[primEnd.x, primEnd.y + 0.15, primEnd.z]}
              center
              distanceFactor={12}
              style={{
                color: '#000',
                fontSize: '10px',
                fontWeight: 'bold',
                background: '#E6D44A',
                padding: '2px 6px',
                borderRadius: '4px',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              EXT (FULL)
            </Html>
            
            <Html
              position={[secEnd.x, secEnd.y + 0.15, secEnd.z]}
              center
              distanceFactor={12}
              style={{
                color: '#fff',
                fontSize: '10px',
                fontWeight: 'bold',
                background: '#C83A3A',
                padding: '2px 6px',
                borderRadius: '4px',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              INT (CUT)
            </Html>
          </group>
        );
      })}
    </group>
  );
}

// T-junction axes visualization
function TJunctionAxes({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  const tJunctions = useMemo(() => detectTJunctions(chains), [chains]);
  
  const y = settings.maxRows * PANEL_HEIGHT * SCALE / 2;
  const axisLength = 0.8; // 80cm visual axis
  
  return (
    <group>
      {tJunctions.map((tj, i) => {
        const mainAngle = tj.mainAngle;
        const branchAngle = tj.branchAngle;
        
        // Main axis (costas) - cyan
        const mainDirX = Math.cos(mainAngle) * axisLength;
        const mainDirZ = Math.sin(mainAngle) * axisLength;
        
        // Branch axis (perna) - magenta
        const branchDirX = Math.cos(branchAngle) * axisLength;
        const branchDirZ = Math.sin(branchAngle) * axisLength;
        
        const center = new THREE.Vector3(tj.x * SCALE, y, tj.y * SCALE);
        
        return (
          <group key={tj.nodeId} position={center}>
            {/* Main axis (costas) - cyan line */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    -mainDirX, 0, -mainDirZ,
                    mainDirX, 0, mainDirZ,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#00FFFF" linewidth={3} />
            </line>
            
            {/* Branch axis (perna) - magenta line */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    0, 0, 0,
                    branchDirX * 2, 0, branchDirZ * 2,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#FF00FF" linewidth={3} />
            </line>
            
            {/* T marker */}
            <Html
              center
              distanceFactor={15}
              style={{
                color: '#fff',
                fontSize: '12px',
                fontWeight: 'bold',
                background: '#44FF44',
                padding: '2px 8px',
                borderRadius: '4px',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              T
            </Html>
          </group>
        );
      })}
    </group>
  );
}

// Run segments with different colors per chain
function RunSegments({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  
  const geometry = useMemo(() => {
    if (chains.length === 0) return null;
    
    // Create line segments for each chain with different colors
    const positions: number[] = [];
    const colors: number[] = [];
    
    chains.forEach((chain, idx) => {
      const color = new THREE.Color(RUN_COLORS[idx % RUN_COLORS.length]);
      
      // Draw chain line at mid-height
      const y = settings.maxRows * PANEL_HEIGHT * SCALE / 2 + 0.05;
      
      positions.push(chain.startX * SCALE, y, chain.startY * SCALE);
      positions.push(chain.endX * SCALE, y, chain.endY * SCALE);
      
      colors.push(color.r, color.g, color.b);
      colors.push(color.r, color.g, color.b);
    });
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    return geo;
  }, [chains, settings.maxRows]);
  
  if (!geometry) return null;
  
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors linewidth={4} />
    </lineSegments>
  );
}

// Middle zone visualization (where orange cuts are allowed)
function MiddleZoneVisualization({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  
  // Middle zone = center 40% of each chain (where CUT_DOUBLE is allowed)
  const zones = useMemo(() => {
    return chains.map(chain => {
      const lengthMm = chain.lengthMm;
      const marginMm = lengthMm * 0.3; // 30% margin from each end
      
      const startMarginMm = marginMm;
      const endMarginMm = lengthMm - marginMm;
      
      const dx = chain.endX - chain.startX;
      const dy = chain.endY - chain.startY;
      const dirX = dx / lengthMm;
      const dirY = dy / lengthMm;
      
      const middleStartX = chain.startX + dirX * startMarginMm;
      const middleStartY = chain.startY + dirY * startMarginMm;
      const middleEndX = chain.startX + dirX * endMarginMm;
      const middleEndY = chain.startY + dirY * endMarginMm;
      
      const middleLength = endMarginMm - startMarginMm;
      
      return {
        chainId: chain.id,
        startX: middleStartX,
        startY: middleStartY,
        endX: middleEndX,
        endY: middleEndY,
        lengthMm: middleLength,
        angle: Math.atan2(dy, dx),
      };
    }).filter(z => z.lengthMm > 0);
  }, [chains]);
  
  const boxGeometry = useMemo(() => 
    new THREE.BoxGeometry(1, 0.05, 0.15), // Flat zone marker
  []);
  
  const y = 0.03; // Just above ground
  
  return (
    <group>
      {zones.map((zone, i) => {
        const centerX = (zone.startX + zone.endX) / 2;
        const centerZ = (zone.startY + zone.endY) / 2;
        const scaleX = zone.lengthMm * SCALE;
        
        return (
          <mesh
            key={zone.chainId}
            position={[centerX * SCALE, y, centerZ * SCALE]}
            rotation={[0, -zone.angle, 0]}
            scale={[scaleX, 1, 1]}
          >
            <boxGeometry args={[1, 0.05, 0.15]} />
            <meshStandardMaterial 
              color="#F2992E" 
              opacity={0.4} 
              transparent 
              emissive="#F2992E"
              emissiveIntensity={0.3}
            />
          </mesh>
        );
      })}
      
      {/* Labels */}
      {zones.length > 0 && (
        <Html
          position={[
            (zones[0].startX + zones[0].endX) / 2 * SCALE,
            0.3,
            (zones[0].startY + zones[0].endY) / 2 * SCALE
          ]}
          center
          distanceFactor={20}
          style={{
            color: '#fff',
            fontSize: '10px',
            fontWeight: 'bold',
            background: '#F2992E',
            padding: '2px 8px',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          Middle Zone (Orange OK)
        </Html>
      )}
    </group>
  );
}

// Index from seed overlay (panel position numbers)
function IndexFromSeedOverlay({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  const PANEL_WIDTH = 1200;
  
  // Generate index positions along chains
  const indexPositions = useMemo(() => {
    const positions: { x: number; y: number; index: number; chainId: string }[] = [];
    
    chains.forEach(chain => {
      const numPanels = Math.ceil(chain.lengthMm / PANEL_WIDTH);
      const dx = chain.endX - chain.startX;
      const dy = chain.endY - chain.startY;
      const dirX = dx / chain.lengthMm;
      const dirY = dy / chain.lengthMm;
      
      for (let i = 0; i < numPanels; i++) {
        const posAlongMm = i * PANEL_WIDTH + PANEL_WIDTH / 2;
        if (posAlongMm > chain.lengthMm) continue;
        
        const x = chain.startX + dirX * posAlongMm;
        const y = chain.startY + dirY * posAlongMm;
        
        positions.push({
          x,
          y,
          index: i,
          chainId: chain.id,
        });
      }
    });
    
    return positions;
  }, [chains]);
  
  const yPos = settings.currentRow * PANEL_HEIGHT * SCALE - PANEL_HEIGHT * SCALE / 2;
  
  return (
    <group>
      {indexPositions.map((pos, i) => (
        <Html
          key={`${pos.chainId}-${pos.index}`}
          position={[pos.x * SCALE, yPos + 0.25, pos.y * SCALE]}
          center
          distanceFactor={15}
          style={{
            color: '#000',
            fontSize: '9px',
            fontWeight: 'bold',
            background: 'rgba(255,255,255,0.85)',
            padding: '1px 4px',
            borderRadius: '3px',
            border: '1px solid #333',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {pos.index}
        </Html>
      ))}
    </group>
  );
}

// L-corner bounding boxes visualization for collision debugging
interface LCornerBoundingBoxesProps extends DebugVisualizationsProps {
  panels?: any[]; // Panel data from layout
}

function LCornerBoundingBoxes({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  const lJunctions = useMemo(() => detectLJunctions(chains), [chains]);
  
  // Create wireframe boxes at each L-junction to show the theoretical panel bounds
  // This helps visualize where panels should meet
  
  const y = PANEL_HEIGHT * SCALE / 2; // Row 1 center height
  const panelDepth = 0.07; // ~70mm foam thickness in meters
  const panelLength = 1.2; // 1200mm panel width in meters
  
  // Get chain by ID
  const chainMap = useMemo(() => {
    const map = new Map<string, typeof chains[0]>();
    chains.forEach(c => map.set(c.id, c));
    return map;
  }, [chains]);
  
  return (
    <group>
      {lJunctions.map((lj) => {
        const primaryChain = chainMap.get(lj.primaryChainId);
        const secondaryChain = chainMap.get(lj.secondaryChainId);
        if (!primaryChain || !secondaryChain) return null;
        
        const junctionPos = [lj.x * SCALE, y, lj.y * SCALE] as [number, number, number];
        
        // Calculate directions for each arm
        const getPrimaryDir = () => {
          const distToStart = Math.hypot(lj.x - primaryChain.startX, lj.y - primaryChain.startY);
          const distToEnd = Math.hypot(lj.x - primaryChain.endX, lj.y - primaryChain.endY);
          
          if (distToStart < distToEnd) {
            return { 
              x: (primaryChain.endX - primaryChain.startX) / primaryChain.lengthMm,
              y: (primaryChain.endY - primaryChain.startY) / primaryChain.lengthMm,
              angle: Math.atan2(primaryChain.endY - primaryChain.startY, primaryChain.endX - primaryChain.startX)
            };
          } else {
            return {
              x: (primaryChain.startX - primaryChain.endX) / primaryChain.lengthMm,
              y: (primaryChain.startY - primaryChain.endY) / primaryChain.lengthMm,
              angle: Math.atan2(primaryChain.startY - primaryChain.endY, primaryChain.startX - primaryChain.endX)
            };
          }
        };
        
        const getSecondaryDir = () => {
          const distToStart = Math.hypot(lj.x - secondaryChain.startX, lj.y - secondaryChain.startY);
          const distToEnd = Math.hypot(lj.x - secondaryChain.endX, lj.y - secondaryChain.endY);
          
          if (distToStart < distToEnd) {
            return { 
              x: (secondaryChain.endX - secondaryChain.startX) / secondaryChain.lengthMm,
              y: (secondaryChain.endY - secondaryChain.startY) / secondaryChain.lengthMm,
              angle: Math.atan2(secondaryChain.endY - secondaryChain.startY, secondaryChain.endX - secondaryChain.startX)
            };
          } else {
            return {
              x: (secondaryChain.startX - secondaryChain.endX) / secondaryChain.lengthMm,
              y: (secondaryChain.startY - secondaryChain.endY) / secondaryChain.lengthMm,
              angle: Math.atan2(secondaryChain.startY - secondaryChain.endY, secondaryChain.startX - secondaryChain.endX)
            };
          }
        };
        
        const primDir = getPrimaryDir();
        const secDir = getSecondaryDir();
        
        // Offset for exterior panels (2 TOOTH = ~141mm = 0.141m)
        const extOffset = 0.141; // meters
        
        return (
          <group key={lj.nodeId}>
            {/* PRIMARY arm bounding box (EXTERIOR) - Yellow wireframe */}
            <group
              position={[
                junctionPos[0] + primDir.x * (panelLength / 2 - extOffset),
                junctionPos[1],
                junctionPos[2] + primDir.y * (panelLength / 2 - extOffset)
              ]}
              rotation={[0, -primDir.angle, 0]}
            >
              <mesh>
                <boxGeometry args={[panelLength, PANEL_HEIGHT * SCALE, panelDepth]} />
                <meshBasicMaterial color="#FFFF00" wireframe transparent opacity={0.8} />
              </mesh>
            </group>
            
            {/* SECONDARY arm bounding box (EXTERIOR) - Cyan wireframe */}
            <group
              position={[
                junctionPos[0] + secDir.x * (panelLength / 2 - extOffset),
                junctionPos[1],
                junctionPos[2] + secDir.y * (panelLength / 2 - extOffset)
              ]}
              rotation={[0, -secDir.angle, 0]}
            >
              <mesh>
                <boxGeometry args={[panelLength, PANEL_HEIGHT * SCALE, panelDepth]} />
                <meshBasicMaterial color="#00FFFF" wireframe transparent opacity={0.8} />
              </mesh>
            </group>
            
            {/* Junction center marker */}
            <mesh position={junctionPos}>
              <sphereGeometry args={[0.05, 8, 8]} />
              <meshBasicMaterial color="#FF0000" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// Wall Dimensions Visualization - shows measurements in TOOTH units
function WallDimensionsVisualization({ chainsResult, settings }: DebugVisualizationsProps) {
  const { chains } = chainsResult;
  
  // Calculate wall measurements
  const toothMm = TOOTH;
  const foamThicknessMm = FOAM_THICKNESS;
  const wallTotalMm = getWallTotalThickness(settings.concreteThickness);
  const concreteMm = getConcreteThicknessMm(settings.concreteThickness);
  
  // Calculate in TOOTH units
  const wallTotalTooth = wallTotalMm / toothMm; // 4 or 5
  const foamTooth = foamThicknessMm / toothMm; // 1
  const concreteTooth = concreteMm / toothMm; // 2 or 3
  
  const y = settings.maxRows * PANEL_HEIGHT * SCALE + 0.5;
  
  // Show one label per chain at midpoint
  const chainLabels = useMemo(() => {
    return chains.map(chain => {
      const midX = (chain.startX + chain.endX) / 2;
      const midY = (chain.startY + chain.endY) / 2;
      
      // Calculate perpendicular direction for offset labels
      const dx = chain.endX - chain.startX;
      const dy = chain.endY - chain.startY;
      const length = Math.hypot(dx, dy);
      const perpX = -dy / length;
      const perpY = dx / length;
      
      // Offset positions for exterior and interior labels
      const offsetDist = wallTotalMm / 2 + 100; // 100mm beyond wall edge
      
      return {
        chainId: chain.id,
        centerX: midX,
        centerY: midY,
        perpX,
        perpY,
        offsetDist,
        chainLength: chain.lengthMm,
      };
    });
  }, [chains, wallTotalMm]);
  
  return (
    <group>
      {/* Global info panel at top */}
      <Html
        position={[0, y + 0.3, 0]}
        center
        distanceFactor={20}
        style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          border: '2px solid #4ade80',
          borderRadius: '8px',
          padding: '12px 16px',
          color: 'white',
          fontSize: '11px',
          fontFamily: 'monospace',
          whiteSpace: 'pre',
          pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        }}
      >
        {`╔═══════════════════════════════════════╗
║ 📏 MEDIDAS EM TOOTH (1200/17 ≈ ${toothMm.toFixed(1)}mm) ║
╠═══════════════════════════════════════╣
║ Espessura ${settings.concreteThickness}mm:                        ║
║ ├─ Total ext→ext: ${wallTotalTooth.toFixed(0)} TOOTH (${wallTotalMm.toFixed(0)}mm)     ║
║ ├─ Painel (foam): ${foamTooth.toFixed(0)} TOOTH (${foamThicknessMm.toFixed(0)}mm)       ║
║ └─ Betão (core):  ${concreteTooth.toFixed(0)} TOOTH (${concreteMm.toFixed(0)}mm)     ║
╚═══════════════════════════════════════╝`}
      </Html>
      
      {/* Per-chain dimension markers */}
      {chainLabels.map(label => {
        const exteriorOffset = label.offsetDist * SCALE;
        const interiorOffset = -label.offsetDist * SCALE;
        
        return (
          <group key={label.chainId}>
            {/* Chain length label at center */}
            <Html
              position={[
                label.centerX * SCALE,
                y - 0.2,
                label.centerY * SCALE
              ]}
              center
              distanceFactor={15}
              style={{
                background: '#0ea5e9',
                borderRadius: '4px',
                padding: '3px 8px',
                color: 'white',
                fontSize: '10px',
                fontWeight: 'bold',
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              {`L: ${(label.chainLength / 1000).toFixed(2)}m (${(label.chainLength / toothMm).toFixed(1)} TOOTH)`}
            </Html>
            
            {/* Exterior wall face marker */}
            <Html
              position={[
                (label.centerX + label.perpX * label.offsetDist) * SCALE,
                y - 0.4,
                (label.centerY + label.perpY * label.offsetDist) * SCALE
              ]}
              center
              distanceFactor={12}
              style={{
                background: '#3b82f6',
                borderRadius: '3px',
                padding: '2px 6px',
                color: 'white',
                fontSize: '9px',
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              EXT
            </Html>
            
            {/* Interior wall face marker */}
            <Html
              position={[
                (label.centerX - label.perpX * label.offsetDist) * SCALE,
                y - 0.4,
                (label.centerY - label.perpY * label.offsetDist) * SCALE
              ]}
              center
              distanceFactor={12}
              style={{
                background: '#8b5cf6',
                borderRadius: '3px',
                padding: '2px 6px',
                color: 'white',
                fontSize: '9px',
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              INT
            </Html>
          </group>
        );
      })}
      
      {/* Wall thickness cross-section indicator lines */}
      {chainLabels.slice(0, 1).map(label => {
        // Only show on first chain for clarity
        const halfWall = (wallTotalMm / 2) * SCALE;
        const halfConcrete = (concreteMm / 2) * SCALE;
        
        const baseX = label.centerX * SCALE;
        const baseZ = label.centerY * SCALE;
        
        // Create dimension line perpendicular to wall
        const positions = new Float32Array([
          baseX + label.perpX * halfWall, y - 0.6, baseZ + label.perpY * halfWall * 1000 * SCALE,
          baseX - label.perpX * halfWall, y - 0.6, baseZ - label.perpY * halfWall * 1000 * SCALE,
        ]);
        
        return (
          <group key={`dim-${label.chainId}`}>
            {/* Dimension line */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    baseX + label.perpX * halfWall, y - 0.55, baseZ + label.perpY * halfWall,
                    baseX - label.perpX * halfWall, y - 0.55, baseZ - label.perpY * halfWall,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#4ade80" linewidth={2} />
            </line>
            
            {/* End caps */}
            <mesh position={[baseX + label.perpX * halfWall, y - 0.55, baseZ + label.perpY * halfWall]}>
              <sphereGeometry args={[0.02, 8, 8]} />
              <meshBasicMaterial color="#4ade80" />
            </mesh>
            <mesh position={[baseX - label.perpX * halfWall, y - 0.55, baseZ - label.perpY * halfWall]}>
              <sphereGeometry args={[0.02, 8, 8]} />
              <meshBasicMaterial color="#4ade80" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// Main component that renders debug visualizations based on settings
export function DebugVisualizations({ chainsResult, settings, selectedCornerNode, onSelectCornerNode, cornerNodeOffsets }: DebugVisualizationsProps) {
  return (
    <group>
      {settings.showSeeds && (
        <SeedMarkers chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showNodeAxes && (
        <TJunctionAxes chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showRunSegments && (
        <RunSegments chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showMiddleZone && (
        <MiddleZoneVisualization chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showIndexFromSeed && (
        <IndexFromSeedOverlay chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showLJunctionArrows && (
        <LJunctionArrows chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showLCornerBoundingBoxes && (
        <LCornerBoundingBoxes chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showWallDimensions && (
        <WallDimensionsVisualization chainsResult={chainsResult} settings={settings} />
      )}
      
      {settings.showCornerNodes && (
        <CornerNodesVisualization 
          chainsResult={chainsResult} 
          settings={settings} 
          selectedCornerNode={selectedCornerNode}
          onSelectCornerNode={onSelectCornerNode}
          cornerNodeOffsets={cornerNodeOffsets}
        />
      )}
    </group>
  );
}
