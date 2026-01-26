
## Plano: Corrigir Deteção de Paredes Exteriores

### Diagnóstico do Problema

O problema está na lógica de deteção de exterior em `computeWallGeometry`:

1. **O `outerPolygon` está a ser calculado como convex hull de TODOS os pontos das paredes** (left e right offsets)
2. **Quando testamos `testLeft`/`testRight` contra este polígono, ambos estão sempre DENTRO** porque o hull foi construído a partir desses mesmos pontos
3. **Resultado**: `leftInside=true && rightInside=true` → `isExteriorWall=false` → faixa branca em tudo

### Solução

Inverter a lógica: em vez de calcular um convex hull de todos os pontos, precisamos de calcular o **footprint interior** do edifício (centerlines ou pontos médios) e depois verificar qual lado da parede está **mais afastado** do centro.

### Alterações a Implementar

#### 1. Modificar `computeOuterPolygon` → `computeBuildingFootprint`

Calcular o polígono central (footprint) usando os **pontos médios** entre left e right de cada parede, ou usando as **centerlines** das paredes.

```text
Antes (convex hull de todos os pontos):
┌─────────────────────────┐
│ ● ● ● ● ● ● ● ● ● ● ●   │ ← todos os pontos ficam DENTRO do hull
└─────────────────────────┘

Depois (footprint central):
      ┌───────────────┐
      │   INTERIOR    │
      │   footprint   │
      └───────────────┘
   ●                     ●  ← pontos exteriores ficam FORA
```

#### 2. Melhorar a Lógica de Deteção em `computeWallGeometry`

Usar uma abordagem mais robusta:
- Calcular o **centróide** do edifício a partir dos nós
- Para cada parede, verificar qual lado está **mais longe** do centróide = lado exterior

Esta é a mesma lógica já documentada em `memory/logic/external-engine-orientation-logic`:
> A face cuja normal aponta para longe do centro é classificada como EXTERIOR

#### 3. Adicionar Logging de Debug

Adicionar logs para verificar a classificação de cada parede:
```typescript
console.log(`[Wall ${wall.id}] isExterior: ${isExteriorWall}, side: ${exteriorSide}`);
```

### Ficheiro a Modificar

**`src/components/viewer/ExternalEngineRenderer.tsx`**

### Mudanças Específicas

```text
1. computeOuterPolygon → computeBuildingCentroid
   - Calcula centróide a partir dos nós do grafo ou pontos médios das paredes
   - Retorna { x: number, y: number }

2. computeWallGeometry (linhas 173-264)
   - Recebe centroid em vez de outerPolygon
   - Para determinar exterior:
     - Calcula distância do leftMid ao centroid
     - Calcula distância do rightMid ao centroid
     - Lado mais longe = exterior
   
3. ExternalEngineRenderer principal
   - Renomear outerPolygon → buildingCentroid
   - Passar centroid às walls

4. WallRenderer
   - Atualizar prop type: outerPolygon → buildingCentroid
```

### Lógica de Deteção Corrigida

```text
Para cada parede:
├── leftMid = ponto médio da polyline left
├── rightMid = ponto médio da polyline right
├── centroid = centro geométrico do edifício
│
├── leftDist = distância(leftMid, centroid)
├── rightDist = distância(rightMid, centroid)
│
└── SE leftDist > rightDist:
       isExteriorWall = true
       exteriorSide = 'left'
    SENÃO SE rightDist > leftDist:
       isExteriorWall = true  
       exteriorSide = 'right'
    SENÃO:
       isExteriorWall = false (parede interior/partição)
       exteriorSide = null
```

### Resultado Esperado

```text
ANTES (tudo branco):
┌──────────────────────────┐
│  ░░░░ ░░░░ ░░░░ ░░░░    │ ← faixa branca
│  FULL  FULL  CUT  FULL   │
└──────────────────────────┘

DEPOIS (azul em exteriores):
┌──────────────────────────┐
│  ████ ████ ████ ████    │ ← faixa AZUL
│  FULL  FULL  CUT  FULL   │   (parede exterior)
└──────────────────────────┘

┌──────────────────────────┐
│  ░░░░ ░░░░ ░░░░ ░░░░    │ ← faixa BRANCA
│  FULL  FULL  FULL FULL   │   (parede interior)
└──────────────────────────┘
```

### Validação

Após implementação:
1. Importar DXF com paredes exteriores e interiores
2. Verificar no console: `[Wall X] isExterior: true/false, side: left/right`
3. Confirmar visualmente:
   - Paredes no perímetro do edifício → faixa AZUL
   - Paredes internas (divisórias) → faixa BRANCA
4. Cores base mantidas: FULL=amarelo, CUT=vermelho
