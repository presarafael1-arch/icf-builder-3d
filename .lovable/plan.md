
## Objetivo
Corrigir a classificação de paredes exteriores para que o painel do **lado de fora** do edifício tenha faixa **AZUL** em ambas as faces, e o painel do **lado de dentro** tenha faixa **BRANCA** em ambas as faces.

## Diagnóstico do Problema

Com base na análise do código e nas respostas do utilizador:
- O footprint está a ser gerado corretamente (polígono verde visível no debug)
- As walls têm offsets válidos
- **MAS** todas as faixas (interior E exterior) aparecem brancas

**Causa raiz identificada**: A função `chooseOutNormal` retorna `isExterior: false` para todas as paredes porque os testes `pointInPolygon` estão a devolver o mesmo resultado para ambos os lados.

Isto acontece quando:
1. O ponto médio da parede (`mid`) está muito próximo ou exatamente sobre o limite do footprint
2. Ambos os pontos de teste (`pPlus` e `pMinus`) caem dentro OU fora do polígono
3. O polígono pode ter orientação incorreta (CW vs CCW)

## Estratégia de Correção

### 1. Normalizar orientação do footprint para CCW
Adicionar função `ensureCCW` que garante que o polígono está em sentido anti-horário, evitando comportamentos inconsistentes do `pointInPolygon`.

### 2. Melhorar a função `chooseOutNormal`
- Aumentar os offsets de teste para valores maiores (até 3.0m)
- Adicionar logs de diagnóstico detalhados
- Usar uma estratégia de votação: testar múltiplos pontos ao longo da parede (não só o midpoint)
- Se todos os testes falharem mas a parede estiver próxima do boundary, usar a distância ao centroid como fallback

### 3. Adicionar informação de orientação no debug
O FootprintDebugViz vai mostrar:
- Orientação do polígono (CW/CCW)
- Área do footprint
- Resultado detalhado da classificação

## Alterações de Código

### Ficheiro: `src/lib/external-engine-footprint.ts`

**Alteração 1** - Exportar `signedPolygonArea` para uso externo:
```typescript
export function signedPolygonArea(poly: Point2D[]): number {
  // ... existing code ...
}
```

**Alteração 2** - Normalizar o output para CCW antes de retornar:
No final de `findOuterPolygonFromSegments`, antes de retornar:
```typescript
const bestFace = metas[0]?.face ?? [];
if (bestFace.length < 3) return [];

// Ensure CCW orientation (positive signed area)
const area = signedPolygonArea(bestFace);
if (area < 0) {
  console.log('[Footprint] Reversing polygon from CW to CCW');
  return [...bestFace].reverse();
}
return bestFace;
```

### Ficheiro: `src/components/viewer/ExternalEngineRenderer.tsx`

**Alteração 3** - Adicionar função `ensureCCW` para normalizar polígonos:
```typescript
function signedPolygonAreaLocal(poly: Point2D[]): number {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}

function ensureCCW(polygon: Point2D[]): Point2D[] {
  if (polygon.length < 3) return polygon;
  const area = signedPolygonAreaLocal(polygon);
  if (area < 0) {
    console.log('[Footprint] Normalizing polygon to CCW');
    return [...polygon].reverse();
  }
  return polygon;
}
```

**Alteração 4** - Refatorar `chooseOutNormal` com diagnóstico melhorado:
```typescript
function chooseOutNormal(
  mid: Point2D,
  n: Point2D,
  outerPoly: Point2D[],
  wallId?: string
): { isExterior: boolean; outN: Point2D } {
  if (outerPoly.length < 3) {
    console.warn(`[Wall ${wallId}] No valid polygon - defaulting to interior`);
    return { isExterior: false, outN: n };
  }

  const boundaryDist = distanceToPolygonBoundary(mid, outerPoly);
  
  // Extended test offsets - go further out for large buildings
  const testEps = [0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
  
  for (const eps of testEps) {
    const pPlus = { x: mid.x + n.x * eps, y: mid.y + n.y * eps };
    const pMinus = { x: mid.x - n.x * eps, y: mid.y - n.y * eps };
    
    const inPlus = pointInPolygon(pPlus, outerPoly);
    const inMinus = pointInPolygon(pMinus, outerPoly);
    
    if (inPlus !== inMinus) {
      const outN = inPlus ? { x: -n.x, y: -n.y } : n;
      console.log(`[Wall ${wallId}] EXTERIOR: eps=${eps}m, outN direction determined`);
      return { isExterior: true, outN };
    }
  }
  
  // Fallback: If wall midpoint is near boundary, treat as exterior
  // and use centroid-based direction for outN
  if (boundaryDist <= 1.0) {
    // Calculate direction from building centroid to wall midpoint
    const centroid = polygonCentroid(outerPoly);
    const toMid = { x: mid.x - centroid.x, y: mid.y - centroid.y };
    const toMidLen = Math.sqrt(toMid.x * toMid.x + toMid.y * toMid.y);
    
    if (toMidLen > 0.01) {
      // outN points away from centroid (towards exterior)
      const outN = { x: toMid.x / toMidLen, y: toMid.y / toMidLen };
      console.log(`[Wall ${wallId}] EXTERIOR (boundary fallback): dist=${boundaryDist.toFixed(3)}m`);
      return { isExterior: true, outN };
    }
  }
  
  // Both sides equal at all offsets → interior partition wall
  console.log(`[Wall ${wallId}] PARTITION: all tests returned same value`);
  return { isExterior: false, outN: n };
}
```

**Alteração 5** - Aplicar normalização CCW no `computeBuildingFootprint`:
No retorno de cada fonte de footprint, aplicar `ensureCCW`:
```typescript
// Priority #1: payload
return { centroid, hull: ensureCCW(shiftedPoly), source: 'payload' };

// Priority #2: graph nodes
return { centroid, hull: ensureCCW(graphPolygon), source: 'nodes' };

// Priority #3: wall offsets
return { centroid, hull: ensureCCW(concavePolygon), source: 'offsets' };
```

**Alteração 6** - Adicionar função helper `polygonCentroid`:
```typescript
function polygonCentroid(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}
```

**Alteração 7** - Atualizar chamada a `computeWallGeometry` para passar wallId:
```typescript
const { isExterior, outN } = chooseOutNormal(wallCenterMid, n2, footprintHull, wall.id);
```

**Alteração 8** - Melhorar FootprintDebugViz com mais informação:
```typescript
function FootprintDebugViz({ hull, centroid, source, exteriorWallCount, totalWallCount }: FootprintDebugProps) {
  // Calculate additional debug info
  const area = hull.length >= 3 ? Math.abs(signedPolygonAreaLocal(hull)) : 0;
  const orientation = hull.length >= 3 
    ? (signedPolygonAreaLocal(hull) > 0 ? 'CCW' : 'CW') 
    : 'N/A';
  
  // ... rest of component with additional info displayed
  <div>Area: <span className="text-green-300">{area.toFixed(1)} m²</span></div>
  <div>Orientation: <span className="text-green-300">{orientation}</span></div>
}
```

## Ficheiros a Modificar
1. `src/lib/external-engine-footprint.ts` - Exportar `signedPolygonArea` e normalizar output para CCW
2. `src/components/viewer/ExternalEngineRenderer.tsx` - Adicionar `ensureCCW`, melhorar `chooseOutNormal`, adicionar logs

## Plano de Teste
1. Recarregar a página do editor
2. Ativar o "Debug Footprint"
3. Verificar no HUD:
   - Orientation: **CCW** (não CW)
   - Exterior walls: **> 0** (não 0)
4. Verificar visualmente:
   - Paredes do perímetro: faixa AZUL em ambas as faces do painel exterior
   - Paredes do perímetro: faixa BRANCA em ambas as faces do painel interior
   - Partições internas: faixa BRANCA em todos os painéis

## Comportamento Visual Esperado

```text
PAREDE DO PERÍMETRO (vista em corte):
┌─────────────────────────────────────────┐
│   EXTERIOR DO EDIFÍCIO                  │
│                                         │
│   ┌────────────────┐                    │
│   │  AZUL  │ AZUL  │  ← Painel exterior │
│   └────────────────┘     (ambas faces)  │
│   ┌────────────────┐                    │
│   │ BRANCO │BRANCO │  ← Painel interior │
│   └────────────────┘     (ambas faces)  │
│                                         │
│   INTERIOR DO EDIFÍCIO                  │
└─────────────────────────────────────────┘

PAREDE INTERNA (partição):
┌─────────────────────────────────────────┐
│   ┌────────────────┐                    │
│   │ BRANCO │BRANCO │  ← Ambos painéis   │
│   └────────────────┘                    │
│   ┌────────────────┐                    │
│   │ BRANCO │BRANCO │  ← Ambos painéis   │
│   └────────────────┘                    │
└─────────────────────────────────────────┘
```

## Secção Técnica

### Porque é que `pointInPolygon` pode falhar

O algoritmo ray-casting usado em `pointInPolygon` pode dar resultados inconsistentes quando:
1. O ponto está exatamente sobre uma aresta do polígono
2. O polígono tem self-intersections
3. O polígono tem orientação incorreta (não afeta ray-casting, mas pode confundir outras lógicas)

### Solução: Múltiplos offsets + fallback centroide

Ao testar com offsets maiores (até 3m), garantimos que os pontos de teste saem claramente do limite do polígono. Se mesmo assim falhar, usamos a direção do centroide para determinar o lado exterior.
