
## Plano: Corrigir Deteção de Paredes Exteriores ✅ IMPLEMENTADO

### Diagnóstico do Problema (Resolvido)

O problema estava na lógica de deteção de exterior em `computeWallGeometry`:

1. **O `outerPolygon` estava a ser calculado como convex hull de TODOS os pontos das paredes** (left e right offsets)
2. **Quando testávamos `testLeft`/`testRight` contra este polígono, ambos estavam sempre DENTRO** porque o hull foi construído a partir desses mesmos pontos
3. **Resultado**: `leftInside=true && rightInside=true` → `isExteriorWall=false` → faixa branca em tudo

### Solução Implementada

Substituída a lógica de convex hull por deteção baseada em **centróide**:

1. **`computeBuildingCentroid`**: Calcula o centro geométrico do edifício a partir dos pontos médios das centerlines de todas as paredes
2. **`computeWallGeometry`**: Para cada parede, compara a distância de cada lado (left/right) ao centróide:
   - Lado **mais longe** do centro = lado **exterior**
   - Se a diferença de distâncias > 10mm → parede exterior
   - Se ambos os lados equidistantes → parede interior (partição)

### Alterações Feitas

**Ficheiro:** `src/components/viewer/ExternalEngineRenderer.tsx`

1. ✅ Removida função `pointInPolygon` (não usada)
2. ✅ Substituída `computeOuterPolygon` → `computeBuildingCentroid`
3. ✅ Atualizada `computeWallGeometry` para usar lógica de distância ao centróide
4. ✅ Adicionados logs de debug: `[Wall ID] isExterior: true/false, side: left/right, leftDist, rightDist, diff`
5. ✅ Atualizadas todas as referências de `outerPolygon` → `buildingCentroid`

### Lógica de Deteção Implementada

```text
Para cada parede:
├── leftMid = ponto médio da polyline left
├── rightMid = ponto médio da polyline right
├── centroid = centro geométrico do edifício
│
├── leftDist = distância(leftMid, centroid)
├── rightDist = distância(rightMid, centroid)
│
└── SE |leftDist - rightDist| > 0.01m:
       isExteriorWall = true
       exteriorSide = leftDist > rightDist ? 'left' : 'right'
    SENÃO:
       isExteriorWall = false (parede interior/partição)
       exteriorSide = null
```

### Resultado Esperado

```text
PAREDES EXTERIORES (perímetro):
┌──────────────────────────┐
│  ████ ████ ████ ████    │ ← faixa AZUL em ambas as faces
│  FULL  FULL  CUT  FULL   │
└──────────────────────────┘

PAREDES INTERIORES (partições):
┌──────────────────────────┐
│  ░░░░ ░░░░ ░░░░ ░░░░    │ ← faixa BRANCA em ambas as faces
│  FULL  FULL  FULL FULL   │
└──────────────────────────┘

Cores base mantidas: FULL=amarelo, CUT=vermelho
```

### Validação

Para validar:
1. Importar DXF com paredes exteriores e interiores
2. Verificar no console: `[Wall X] isExterior: true/false, side: left/right`
3. Confirmar visualmente:
   - Paredes no perímetro do edifício → faixa AZUL
   - Paredes internas (divisórias) → faixa BRANCA
4. Cores base mantidas: FULL=amarelo, CUT=vermelho
