
# Plano: Corrigir Deteção de Paredes Exteriores e Opacidade ✅ IMPLEMENTADO

## Alterações Realizadas

### A) Opacidade (100% Opaco) ✅
- `PanelSkin` (meshStandardMaterial): `transparent={false}` + `opacity={1}`
- `PanelStripe` (meshBasicMaterial): `transparent={false}` + `opacity={1}`
- `WallFallback` surfaces (meshStandardMaterial): `transparent={false}` + `opacity={1}`
- `WallFallback` stripes (meshBasicMaterial): `transparent={false}` + `opacity={1}`

### B) Footprint Côncavo (Sem Convex Hull) ✅
Nova função `computeBuildingFootprint` com prioridades:

1. **Payload outerPolygon** (via `extractOuterPolygonFromPayload`):
   - `layout.analysis?.footprint?.outerPolygon`
   - `layout.meta?.outerPolygon`
   - `layout.outerPolygon`
   
2. **Construção Côncava** (via `buildConcaveFootprintFromWalls`):
   - Para cada parede, escolhe a polyline mais afastada do centróide
   - Ordena pontos por ângulo para criar polígono fechado
   - Remove duplicados com tolerância de 10mm

3. **Convex Hull** (apenas como último recurso com warning)

### C) chooseOutNormal Melhorado ✅
Testa em 5 offsets: `[0.1, 0.25, 0.5, 0.75, 1.0]` metros

## Resultado Esperado

- **Paredes perimetrais em L/U**: Faixa AZUL no lado exterior
- **Paredes interiores**: Faixa BRANCA em ambos os lados
- **Painéis 100% opacos**: Sem translucidez
