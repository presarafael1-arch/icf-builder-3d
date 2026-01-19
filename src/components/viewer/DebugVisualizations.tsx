/**
 * Debug Visualizations for Panel Layout - SIMPLIFIED
 * 
 * Shows ONLY:
 * - Corner nodes (L-junction nodes) with Labels and Wires
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { ChainsResult } from '@/lib/wall-chains';
import { detectLJunctions } from '@/lib/panel-layout';
import { PANEL_HEIGHT, ViewerSettings, TOOTH } from '@/types/icf';

// Scale factor: mm to meters
const SCALE = 0.001;

interface DebugVisualizationsProps {
  chainsResult: ChainsResult;
  settings: ViewerSettings;
  selectedCornerNode?: string | null;
  onSelectCornerNode?: (nodeId: string | null) => void;
  cornerNodeOffsets?: Map<string, { nodeId: string; offsetX: number; offsetY: number }>;
  flippedChains?: Set<string>;
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

        const extNodeId = `node-${lj.nodeId}-ext`;
        const intNodeId = `node-${lj.nodeId}-int`;
        
        const extOffset = cornerNodeOffsets?.get(extNodeId);
        const intOffset = cornerNodeOffsets?.get(intNodeId);
        const extOffsetX = (extOffset?.offsetX ?? 0) * TOOTH;
        const extOffsetY = (extOffset?.offsetY ?? 0) * TOOTH;
        const intOffsetX = (intOffset?.offsetX ?? 0) * TOOTH;
        const intOffsetY = (intOffset?.offsetY ?? 0) * TOOTH;

        const extNode = {
          x: lj.exteriorNode.x + extOffsetX,
          y: lj.exteriorNode.y + extOffsetY,
        };
        const intNode = {
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
                <line key={`ext-wire-${lj.nodeId}-${extNode.x}-${extNode.y}`}>
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
                  <lineBasicMaterial
                    color={isExtSelected ? "#FFFFFF" : "#FF0000"}
                    linewidth={isExtSelected ? 3 : 2}
                    depthTest={false}
                  />
                </line>
              )}

              <line key={`ext-conn-${lj.nodeId}-${extNode.x}-${extNode.y}`}>
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
                <lineBasicMaterial color={isExtSelected ? "#FFFFFF" : "#FF0000"} linewidth={2} depthTest={false} />
              </line>

              <group position={[extNode.x * SCALE, yTop, extNode.y * SCALE]}>
                <mesh 
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(extNodeId, e); }}
                  onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                  onPointerOut={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
                >
                  <sphereGeometry args={[0.25, 16, 16]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
                
                <mesh>
                  <sphereGeometry args={[isExtSelected ? 0.18 : 0.12, 16, 16]} />
                  <meshStandardMaterial 
                    color={isExtSelected ? "#FFFFFF" : "#FF0000"} 
                    emissive={isExtSelected ? "#FF0000" : "#FF0000"} 
                    emissiveIntensity={isExtSelected ? 1.2 : 0.8} 
                  />
                </mesh>

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
                <line key={`int-wire-${lj.nodeId}-${intNode.x}-${intNode.y}`}>
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
                  <lineBasicMaterial
                    color={isIntSelected ? "#FFFFFF" : "#FFCC00"}
                    linewidth={isIntSelected ? 3 : 2}
                    depthTest={false}
                  />
                </line>
              )}

              <line key={`int-conn-${lj.nodeId}-${intNode.x}-${intNode.y}`}>
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
                <lineBasicMaterial color={isIntSelected ? "#FFFFFF" : "#FFCC00"} linewidth={2} depthTest={false} />
              </line>

              <group position={[intNode.x * SCALE, yTop, intNode.y * SCALE]}>
                <mesh 
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(intNodeId, e); }}
                  onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                  onPointerOut={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
                >
                  <sphereGeometry args={[0.25, 16, 16]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
                
                <mesh>
                  <sphereGeometry args={[isIntSelected ? 0.18 : 0.12, 16, 16]} />
                  <meshStandardMaterial 
                    color={isIntSelected ? "#FFFFFF" : "#FFCC00"} 
                    emissive={isIntSelected ? "#FFCC00" : "#FFCC00"} 
                    emissiveIntensity={isIntSelected ? 1.2 : 0.8} 
                  />
                </mesh>

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

// Main component - SIMPLIFIED: only renders corner nodes (always visible when showCornerNodes is true)
export function DebugVisualizations({ chainsResult, settings, selectedCornerNode, onSelectCornerNode, cornerNodeOffsets, flippedChains }: DebugVisualizationsProps) {
  return (
    <group>
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
