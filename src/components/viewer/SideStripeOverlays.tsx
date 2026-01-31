import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { ClassifiedPanel } from '@/lib/panel-layout';
import { PANEL_HEIGHT, TOOTH, ConcreteThickness } from '@/types/icf';

// Scale factor: convert mm to 3D units (1 unit = 1 meter)
const SCALE = 0.001;

// Stripe dimensions
const STRIPE_WIDTH_MM = 100; // 100mm width (adjustable 80-120mm)
const STRIPE_HEIGHT_RATIO = 0.85; // 85% of panel height
const STRIPE_OFFSET_MM = 1; // 1mm offset from panel surface

// Stripe colors
const EXTERIOR_COLOR = '#3B82F6'; // Blue for EXT panels
const INTERIOR_COLOR = '#FFFFFF'; // White for INT panels

// Stripe opacity (80% as requested)
const STRIPE_OPACITY = 0.8;

interface SideStripeOverlaysProps {
  allPanels: ClassifiedPanel[];
  concreteThickness: ConcreteThickness;
  visible?: boolean; // Toggle visibility from parent
}

/**
 * Renders EXT/INT stripe overlays on each panel's BOTH faces.
 * 
 * Logic (corrected):
 * - If panel.side === 'exterior' => BLUE stripe on BOTH faces (+Z and -Z)
 * - If panel.side === 'interior' => WHITE stripe on BOTH faces (+Z and -Z)
 * 
 * This means EXT panels have blue on both sides, INT panels have white on both sides.
 * Stripes use raycast override to not interfere with picking.
 */
export function SideStripeOverlays({ allPanels, concreteThickness, visible = true }: SideStripeOverlaysProps) {
  // Refs for 4 instanced meshes:
  // - EXT panels front face (blue)
  // - EXT panels back face (blue)
  // - INT panels front face (white)
  // - INT panels back face (white)
  const extFrontMeshRef = useRef<THREE.InstancedMesh>(null);
  const extBackMeshRef = useRef<THREE.InstancedMesh>(null);
  const intFrontMeshRef = useRef<THREE.InstancedMesh>(null);
  const intBackMeshRef = useRef<THREE.InstancedMesh>(null);

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

  // Separate panels by side and calculate matrices for both faces
  const { extPanels, intPanels, extFrontMatrices, extBackMatrices, intFrontMatrices, intBackMatrices } = useMemo(() => {
    const extPanels: ClassifiedPanel[] = [];
    const intPanels: ClassifiedPanel[] = [];
    const extFrontMatrices: THREE.Matrix4[] = [];
    const extBackMatrices: THREE.Matrix4[] = [];
    const intFrontMatrices: THREE.Matrix4[] = [];
    const intBackMatrices: THREE.Matrix4[] = [];

    // Stripe offset from panel center (in local Z direction)
    const stripeOffsetM = (halfPanelThickness + STRIPE_OFFSET_MM) * SCALE;

    allPanels.forEach((panel) => {
      // Decompose panel matrix to get position, rotation, scale
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      panel.matrix.decompose(pos, quat, scale);

      // Get panel's local Z direction in world space
      const localZDir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);

      // Front face stripe (+Z face)
      const frontPos = pos.clone().add(localZDir.clone().multiplyScalar(stripeOffsetM));
      const frontMatrix = new THREE.Matrix4();
      frontMatrix.compose(frontPos, quat, new THREE.Vector3(1, 1, 1));

      // Back face stripe (-Z face)
      const backPos = pos.clone().add(localZDir.clone().multiplyScalar(-stripeOffsetM));
      // Rotate 180° around Y axis to face the opposite direction
      const backQuat = quat.clone().multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      );
      const backMatrix = new THREE.Matrix4();
      backMatrix.compose(backPos, backQuat, new THREE.Vector3(1, 1, 1));

      // Classify by panel side
      if (panel.side === 'exterior') {
        extPanels.push(panel);
        extFrontMatrices.push(frontMatrix);
        extBackMatrices.push(backMatrix);
      } else {
        // 'interior' or default
        intPanels.push(panel);
        intFrontMatrices.push(frontMatrix);
        intBackMatrices.push(backMatrix);
      }
    });

    return { extPanels, intPanels, extFrontMatrices, extBackMatrices, intFrontMatrices, intBackMatrices };
  }, [allPanels, halfPanelThickness]);

  // Update EXT front mesh instances
  useEffect(() => {
    if (!extFrontMeshRef.current || extFrontMatrices.length === 0) return;
    extFrontMatrices.forEach((matrix, i) => {
      extFrontMeshRef.current!.setMatrixAt(i, matrix);
    });
    extFrontMeshRef.current.instanceMatrix.needsUpdate = true;
    extFrontMeshRef.current.raycast = () => {};
  }, [extFrontMatrices]);

  // Update EXT back mesh instances
  useEffect(() => {
    if (!extBackMeshRef.current || extBackMatrices.length === 0) return;
    extBackMatrices.forEach((matrix, i) => {
      extBackMeshRef.current!.setMatrixAt(i, matrix);
    });
    extBackMeshRef.current.instanceMatrix.needsUpdate = true;
    extBackMeshRef.current.raycast = () => {};
  }, [extBackMatrices]);

  // Update INT front mesh instances
  useEffect(() => {
    if (!intFrontMeshRef.current || intFrontMatrices.length === 0) return;
    intFrontMatrices.forEach((matrix, i) => {
      intFrontMeshRef.current!.setMatrixAt(i, matrix);
    });
    intFrontMeshRef.current.instanceMatrix.needsUpdate = true;
    intFrontMeshRef.current.raycast = () => {};
  }, [intFrontMatrices]);

  // Update INT back mesh instances
  useEffect(() => {
    if (!intBackMeshRef.current || intBackMatrices.length === 0) return;
    intBackMatrices.forEach((matrix, i) => {
      intBackMeshRef.current!.setMatrixAt(i, matrix);
    });
    intBackMeshRef.current.instanceMatrix.needsUpdate = true;
    intBackMeshRef.current.raycast = () => {};
  }, [intBackMatrices]);

  // Don't render if not visible or no panels
  if (!visible || allPanels.length === 0) return null;

  const extCount = extPanels.length;
  const intCount = intPanels.length;

  return (
    <>
      {/* EXT panels - BLUE stripes on BOTH faces */}
      {extCount > 0 && (
        <>
          <instancedMesh
            ref={extFrontMeshRef}
            args={[stripeGeometry, undefined, extCount]}
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
          <instancedMesh
            ref={extBackMeshRef}
            args={[stripeGeometry, undefined, extCount]}
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
        </>
      )}

      {/* INT panels - WHITE stripes on BOTH faces */}
      {intCount > 0 && (
        <>
          <instancedMesh
            ref={intFrontMeshRef}
            args={[stripeGeometry, undefined, intCount]}
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
          <instancedMesh
            ref={intBackMeshRef}
            args={[stripeGeometry, undefined, intCount]}
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
      )}
    </>
  );
}
