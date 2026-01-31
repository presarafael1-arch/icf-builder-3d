
## Objetivo
Garantir que, no modo “External Engine”, as paredes/painéis exteriores sejam identificados corretamente e, portanto, a faixa de identificação no exterior fique **AZUL** (e não branca). Manter as cores FULL/CUT (amarelo/vermelho) como estão.

## Diagnóstico (porque hoje fica tudo branco)
Pelo comportamento descrito (“por fora todos os painéis estão com mesh/faixa branca”), o mais provável é:
- o `footprintHull` (polígono de footprint) está a ficar **vazio** ou inválido; e quando isso acontece:
  - `pointInPolygon(...)` devolve sempre `false`,
  - `chooseOutNormal(...)` conclui `isExterior: false`,
  - logo `isExteriorWall` fica `false` para (quase) todas as paredes,
  - e a lógica de cor da faixa passa a **branca**.

Neste momento o footprint é tentado por:
1) `outerPolygon` do payload (se existir)
2) fallback por offsets `left/right` (face-walking)
Se ambas falham → hull vazio → tudo “interior”.

## Estratégia aprovada (Auto: payload > nodes > offsets)
Vamos tornar o cálculo do footprint verdadeiramente “auto” e mais robusto:
1) **Payload outerPolygon** (mantém-se como 1ª prioridade, com `centerOffset` aplicado)
2) **Footprint por centerlines (nodes + walls)** como 2ª prioridade (novo)
   - Construir “segment soup” usando a geometria do grafo:
     - para cada `GraphWall`, usar `start_node` e `end_node`
     - obter as coordenadas 2D via `GraphNode.position` (já com `centerOffset` aplicado, tal como o renderer faz)
     - alimentar esses segmentos no `findOuterPolygonFromSegments(...)` com snapping adaptativo
   - Esta abordagem tende a fechar melhor loops (especialmente quando offsets têm pequenos gaps)
3) **Footprint por offsets left/right** como 3ª prioridade (fica como fallback final)

Se mesmo assim não houver hull, continuaremos a marcar como “sem footprint” e vamos expor isso claramente no debug (em vez de “falhar silenciosamente”).

## Alterações de código (o que vou mexer)
### 1) `ExternalEngineRenderer.tsx` — refactor do footprint
- Atualizar `computeBuildingFootprint(...)` para receber também `nodes` (ou receber um “lookup map” de nodes).
- Implementar `buildConcaveFootprintFromGraph(nodes, walls)`:
  - criar `Map(nodeId -> Point2D)`
  - criar segmentos `{a,b}` com base nas ligações `start_node/end_node`
  - usar `findOuterPolygonFromSegments(segments, snapTol)` com `snapCandidates` (ex.: 0.02 → 0.5m)
- Ajustar a ordem:
  - `payloadPolygon` (shifted) → `graphCenterlines` → `offsets`
- Melhorar logs: imprimir qual fonte foi usada e quantos pontos tem o hull.

### 2) Debug Visual (aprovado)
Adicionar um modo de debug leve dentro do renderer (sem mexer no backend):
- Um toggle (ex.: `showFootprintDebug`) dentro do UI/overlay de diagnósticos do editor (provavelmente onde já existem controlos/visibilidades).
- Quando ativo:
  - desenhar o `footprintHull` como uma linha (verde) na cena 3D
  - desenhar também o centroide (pequena esfera) e mostrar texto com:
    - “Fonte do hull: payload / nodes / offsets / none”
    - “Hull points: N”
    - “Exterior walls: X / total: Y”
  - Configuração visual do footprint:
    - `depthTest={false}`, `depthWrite={false}`, `renderOrder` alto
    - para ser sempre legível (sem interferir com a opacidade dos painéis)

### 3) Verificação de que a faixa azul depende apenas de `isExteriorWall`
- Confirmar que o pedido é “Só a faixa” (não pintar o painel inteiro).
- Manter a lógica existente:
  - `exteriorSkinStripeColor = isExteriorWall ? BLUE : WHITE`
- O foco passa a ser: garantir que `isExteriorWall` fica `true` nos perímetros.

## Casos limite e como vamos lidar
- **DXF espelhado (mirror X/Y)**: o footprint pode ficar invertido ou desfasado; o debug visual vai tornar isso óbvio imediatamente.
- **Walls com offsets incompletos**: o fallback por centerlines não depende de offsets, por isso vai cobrir muitos casos.
- **Courtyards / pátios internos**: o face-walking por centerlines deve produzir múltiplas faces; a seleção “best face” por containment/area tende a escolher o envelope exterior.

## Plano de teste (end-to-end)
1) Abrir o mesmo projeto no editor e recarregar.
2) Ativar o “Debug Footprint”.
3) Confirmar:
   - o polígono verde (footprint) envolve o edifício corretamente (incluindo concavidades L/U),
   - as paredes/painéis do perímetro passam a ter faixa **AZUL** do lado exterior,
   - paredes internas continuam com faixa branca.
4) Se ainda houver discrepâncias:
   - usar o debug para identificar se o hull está errado (fonte, snapping) e ajustar tolerâncias.

## Resultado esperado
- “Por fora” (face exterior das paredes do perímetro) a faixa passa a **AZUL** consistentemente.
- A leitura FULL/CUT mantém-se (amarelo/vermelho) porque o azul é só a faixa de identificação.
- O debug permite explicar rapidamente qualquer caso que ainda falhe (em vez de tentativa/erro às cegas).
