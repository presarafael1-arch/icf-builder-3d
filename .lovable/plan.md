
Objetivo: corrigir (1) faixas azuis em todas as paredes exteriores (incluindo concavidades L/U) e (2) aparência “translúcida” nos painéis (amarelo/vermelho) no modo **External Engine**, alterando apenas `src/components/viewer/ExternalEngineRenderer.tsx`.

---

## 1) Diagnóstico do que está a acontecer agora

### 1.1 Porque “todas as paredes exteriores passaram a faixa branca”
No `ExternalEngineRenderer.tsx`, a cor azul só acontece quando `isExteriorWall === true`.

Neste momento, o console está a dizer:
`[Footprint] No outerPolygon in payload and could not build concave loop from walls`

Quando o footprint falha, `computeBuildingFootprint()` devolve `hull: []`.
Depois, `chooseOutNormal(..., outerPoly=[])` faz `pointInPolygon(..., []) => false`, nunca encontra `inPlus != inMinus`, e retorna:
- `isExterior: false`

Resultado: **todas as paredes passam a ser tratadas como partições internas**, logo ficam todas com faixa branca.

### 1.2 Porque os painéis “ainda parecem translúcidos”
Mesmo com `transparent={false}` e `opacity={1}`, pode continuar a parecer “a deixar passar” por dois motivos típicos neste caso:

1) **Z-fighting/overlay interference**: linhas/overlays no mesmo plano (ou muito perto) podem criar artefactos visuais que parecem transparência. Já adicionámos `polygonOffset` no `PanelSkin`, mas podemos ter de tornar a base ainda mais “flat/solid”.

2) **Material PBR (meshStandardMaterial) + iluminação**: `meshStandardMaterial` reage a luz/ambiente e pode parecer “lavado/sem corpo” em determinadas exposições; isto é frequentemente interpretado como translucidez. Para uma cor “chapada e sólida”, o material mais robusto é `meshBasicMaterial` (não depende de luz).

---

## 2) Correção do FOOTPRINT (sem convex hull e sem falhas em L/U)

### 2.1 Prioridade #1: outerPolygon vindo do payload (manter)
Já existe `extractOuterPolygonFromPayload(layout)` com:
- `layout.analysis?.footprint?.outerPolygon`
- `layout.meta?.outerPolygon`
- `layout.outerPolygon`
- `layout.footprint?.outerPolygon`

Isto fica (está correto).

### 2.2 Prioridade #2: fallback robusto sem convex hull (substituir o builder atual)
O builder atual (`buildConcaveFootprintFromWalls`) está a falhar em fechar o loop (mesmo com “bridging”). Em vez de reinventar um detector de footprint aqui, vamos reutilizar o **detector robusto já existente no projeto** (o mesmo que funciona para DXF com concavidades e T-junctions):

- `buildWallChainsAutoTuned(...)` + `detectFootprintAndClassify(...)` (já integrado em `wall-chains.ts`)
- Isto usa o algoritmo half-edge/face-walking (robusto para L/U) e devolve `outerPolygon` côncavo.

#### Implementação (dentro do ExternalEngineRenderer.tsx)
1) Importar a função já existente:
   - `buildWallChainsAutoTuned` de `@/lib/wall-chains`
   - e o tipo `WallSegment` de `@/types/icf` (ou criar um tipo local compatível, mas preferível reusar o tipo).

2) Converter `GraphWall[]` (engine) em `WallSegment[]` (centro-linhas), porque o footprint interno trabalha com centro-linhas:
   - Para cada `wall`, obter `leftPts` e `rightPts`.
   - Derivar endpoints do **centro da parede** (média do left/right no início e no fim):
     - `start = (leftPts[0] + rightPts[0]) / 2`
     - `end   = (leftPts[last] + rightPts[last]) / 2`
   - Converter de metros para milímetros (multiplicar por 1000), porque `wall-chains/footprint-detection` trabalham em mm.
   - Preencher campos exigidos: `id`, `projectId` (pode ser string fixa), `startX`, `startY`, `endX`, `endY`, `length`, `angle`.

3) Executar:
   - `const chainsResult = buildWallChainsAutoTuned(wallSegmentsMm)`
   - `const outerPolygonMm = chainsResult.footprint?.outerPolygon`
   - Se `outerPolygonMm?.length >= 3`, converter de volta para metros (`/1000`) e usar como `footprintHull`.

4) Logs:
   - Se usar este fallback: `console.log("[Footprint] Using chain-based footprint (wall-chains) ...")`
   - Se mesmo assim falhar: manter o `console.warn(...)` atual.

Com isto:
- O footprint deixa de depender de um loop “ad hoc” e passa a usar o algoritmo já comprovado no projeto.
- Paredes exteriores em concavidades L/U voltam a ser classificadas como exteriores.

---

## 3) chooseOutNormal (manter e ligar ao novo outerPoly)
Aqui está correto manter os eps:
- `[0.1, 0.25, 0.5, 0.75, 1.0]`

Apenas garantimos que `outerPoly` nunca vem vazio quando há geometria suficiente; com o fallback novo, deverá ser raro ficar vazio.

---

## 4) Opacidade / Painéis 100% sólidos (corrigir aparência)

### 4.1 Garantia “hard” de não depender de luz (mais sólido visualmente)
Alterar `PanelSkin` para usar `meshBasicMaterial` em vez de `meshStandardMaterial`.

Motivo: `meshBasicMaterial` é 100% opaco por definição (sem shading PBR), e a cor fica “chapada”, eliminando a sensação de translucidez causada por iluminação/exposição.

Implementação no `PanelSkin`:
- Trocar:
  - `<meshStandardMaterial ... />`
  por
  - `<meshBasicMaterial ... />`
- Manter:
  - `transparent={false}`
  - `opacity={1}`
  - `side={THREE.DoubleSide}`
  - `depthWrite`
  - `depthTest`
  - `polygonOffset` (para evitar z-fighting com stripes/outline)

### 4.2 Garantir que nenhum material de painel/overlay usa transparent=true
No `ExternalEngineRenderer.tsx`:
- Confirmar que:
  - `PanelStripe` já tem `transparent={false} opacity={1}` (ok)
  - `WallFallback` meshes também têm `transparent={false} opacity={1}` (ok)
- Rever materiais de outlines/lines se estiverem a interferir visualmente:
  - `PanelOutline` usa `<Line ... depthTest={false} />` (não é transparente, mas está sempre visível; isto pode “dar impressão” de ver através. Podemos manter, mas se necessário, ajustar `depthTest={true}` e `polygonOffset`/renderOrder para reduzir artefactos.)

---

## 5) Debug curto para validar (sem depender de screenshots)
Para garantir que “a parede errada é sempre a mesma” fica mesmo corrigida:

1) Adicionar um log por wall quando o footprint está disponível:
   - `wall.id`, `isExteriorWall`, `exteriorSide`, `dotLeft`, e se `footprintHull.length`.

2) (Opcional) Se já existir uma opção de “Mostrar Footprint” no UI do modo External Engine, desenhar a polyline do `footprintHull` (verde) para confirmar visualmente que apanha a concavidade. Se não existir no renderer externo, podemos adicionar um toggle simples via props/settings numa etapa posterior.

---

## 6) Sequência de implementação (ordem exata)

1) **ExternalEngineRenderer.tsx**
   - Adicionar imports de `buildWallChainsAutoTuned` e `WallSegment`.
2) Substituir o fallback `buildConcaveFootprintFromWalls` por `buildFootprintViaWallChains(...)` (novo helper local):
   - Converter `GraphWall[]` → `WallSegment[]` (mm)
   - `buildWallChainsAutoTuned`
   - Ler `footprint.outerPolygon`
   - Converter para metros
3) Atualizar `computeBuildingFootprint`:
   - manter payload outerPolygon como #1
   - usar wall-chains como #2
   - manter “sem convex hull” como requisito (sem fallback final convex)
4) **Opacidade**:
   - Trocar `meshStandardMaterial` → `meshBasicMaterial` no `PanelSkin`
   - Confirmar `transparent={false} opacity={1}` em todos os materiais relevantes
5) Teste manual no editor:
   - confirmar que o log de footprint já não diz “could not build”
   - confirmar que `isExteriorWall` volta a true para paredes do perímetro
   - confirmar que a parede específica (a que falhava sempre) agora mostra faixa azul no lado exterior
   - confirmar que amarelo/vermelho não parecem “a deixar passar”

---

## Resultado esperado (depois destas alterações)

- Footprint deixa de falhar em L/U mesmo sem `outerPolygon` no payload.
- `isExteriorWall` volta a funcionar para o perímetro completo (incluindo concavidades).
- Faixa azul aparece no lado exterior em todas as paredes exteriores; interior/partições ficam brancas.
- Painéis amarelos/vermelhos ficam visualmente “sólidos” (sem aparência de translucidez), porque a cor base passa a ser flat e independente de iluminação.
