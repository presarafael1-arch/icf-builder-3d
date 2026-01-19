import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { ClassifiedPanel } from '@/lib/panel-layout';
import { PANEL_HEIGHT, TOOTH, getWallTotalThickness, ConcreteThickness } from '@/types/icf';

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

// Stripe dimensions
const STRIPE_WIDTH_MM = 100; // 100mm width (adjustable 80-120mm)
const STRIPE_HEIGHT_RATIO = 0.85; // 85% of panel height
const STRIPE_OFFSET_MM = 1; // 1mm offset from panel surface

// Stripe colors
const EXTERIOR_COLOR = '#3B82F6'; // Blue
const INTERIOR_COLOR = '#FFFFFF'; // White

// Stripe opacity (80% as requested)
const STRIPE_OPACITY = 0.8;

interface SideStripeOverlaysProps {
  allPanels: ClassifiedPanel[];
  concreteThickness: ConcreteThickness;
  visible?: boolean; // Toggle visibility from parent
}

/**
 * Renders EXT/INT stripe overlays on each panel's faces.
 * - Blue stripe on exterior face (z = +tc/2 + 1mm)
 * - White stripe on interior face (z = -tc/2 - 1mm)
 * 
 * Stripes are centered on panels and use raycast override to not interfere with picking.
 */
export function SideStripeOverlays({ allPanels, concreteThickness, visible = true }: SideStripeOverlaysProps) {
  const extMeshRef = useRef<THREE.InstancedMesh>(null);
  const intMeshRef = useRef<THREE.InstancedMesh>(null);

  // Total wall thickness in mm
  const wallThicknessMm = getWallTotalThickness(concreteThickness);
  // Half thickness for positioning
  const halfThicknessMm = wallThicknessMm / 2;
  
  // Panel thickness (1 TOOTH)
  const panelThicknessMm = TOOTH;
  const halfPanelThickness = panelThicknessMm / 2;

  // Stripe geometry: PlaneGeometry(width, height)
  const stripeGeometry = useMemo(() => {
    const stripeHeightMm = PANEL_HEIGHT * STRIPE_HEIGHT_RATIO;
    return new THREE.PlaneGeometry(
      STRIPE_WIDTH_MM * SCALE,
      stripeHeightMm * SCALE
    );
  }, []);

  // Calculate matrices for each panel's stripes
  const { extMatrices, intMatrices } = useMemo(() => {
    const extMatrices: THREE.Matrix4[] = [];
    const intMatrices: THREE.Matrix4[] = [];

    allPanels.forEach((panel) => {
      // Decompose panel matrix to get position, rotation, scale
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      panel.matrix.decompose(pos, quat, scale);

      // Determine which side is exterior based on panel side property
      const isExteriorPanel = panel.side === 'exterior';
      
      // Get panel's local Z direction in world space
      // Panel's +Z face is the "exterior" face, -Z is "interior"
      // After rotation by quat, need to transform local Z to world Z
      const localZDir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
      
      // Stripe offset from panel center (in local Z direction)
      const stripeOffsetM = (halfPanelThickness + STRIPE_OFFSET_MM) * SCALE;

      // EXT stripe: on +Z face (outward from panel)
      const extPos = pos.clone().add(localZDir.clone().multiplyScalar(stripeOffsetM));
      const extMatrix = new THREE.Matrix4();
      extMatrix.compose(extPos, quat, new THREE.Vector3(1, 1, 1));
      extMatrices.push(extMatrix);

      // INT stripe: on -Z face (inward from panel)
      const intPos = pos.clone().add(localZDir.clone().multiplyScalar(-stripeOffsetM));
      // Rotate 180° around Y axis to face the opposite direction
      const intQuat = quat.clone().multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      );
      const intMatrix = new THREE.Matrix4();
      intMatrix.compose(intPos, intQuat, new THREE.Vector3(1, 1, 1));
      intMatrices.push(intMatrix);
    });

    return { extMatrices, intMatrices };
  }, [allPanels, halfPanelThickness]);

  // Update EXT mesh instances
  useEffect(() => {
    if (!extMeshRef.current || extMatrices.length === 0) return;
    extMatrices.forEach((matrix, i) => {
      extMeshRef.current!.setMatrixAt(i, matrix);
    });
    extMeshRef.current.instanceMatrix.needsUpdate = true;
    // Disable raycast for stripes
    extMeshRef.current.raycast = () => {};
  }, [extMatrices]);

  // Update INT mesh instances
  useEffect(() => {
    if (!intMeshRef.current || intMatrices.length === 0) return;
    intMatrices.forEach((matrix, i) => {
      intMeshRef.current!.setMatrixAt(i, matrix);
    });
    intMeshRef.current.instanceMatrix.needsUpdate = true;
    // Disable raycast for stripes
    intMeshRef.current.raycast = () => {};
  }, [intMatrices]);

  // Don't render if not visible or no panels
  if (!visible || allPanels.length === 0) return null;

  return (
    <>
      {/* EXTERIOR stripes - Blue */}
      <instancedMesh
        ref={extMeshRef}
        args={[stripeGeometry, undefined, allPanels.length]}
        frustumCulled={false}
        renderOrder={20}
      >
        <meshBasicMaterial
          color={EXTERIOR_COLOR}
          transparent
          opacity={STRIPE_OPACITY}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </instancedMesh>

      {/* INTERIOR stripes - White */}
      <instancedMesh
        ref={intMeshRef}
        args={[stripeGeometry, undefined, allPanels.length]}
        frustumCulled={false}
        renderOrder={20}
      >
        <meshBasicMaterial
          color={INTERIOR_COLOR}
          transparent
          opacity={STRIPE_OPACITY}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </instancedMesh>
    </>
  );
}
