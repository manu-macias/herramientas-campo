# 🌾 Soja vs Dólar — Herramientas de campo

Herramienta privada de decisión para una familia de productores agropecuarios: ayuda a decidir cuándo conviene vender **soja** vs. **dólares** según los precios del día, los promedios recientes y el contexto de cada uno.

Es la versión "de producción" del [Agro Dashboard](https://github.com/manu-macias/agro-dashboard): con login y datos reales de la planilla familiar.

## Stack

- **Frontend:** React 18 (sin bundler — `React.createElement` puro, sin JSX/Babel para compatibilidad con la CSP de GitHub Pages)
- **Gráfico:** Chart.js (líneas, doble eje soja/dólar)
- **Auth:** login con hash SHA-256 via Web Crypto API + `sessionStorage`
- **Datos de precios:** `prices.json` con serie diaria, regenerado por un GitHub Action (ver abajo)
- **Datos de ventas:** Google Sheets privado → Google Apps Script Web App (API REST) → fetch desde el cliente
- **Deploy:** GitHub Pages (sitio estático)

## Funcionalidades

- **📊 Decisión:** scoring que pondera precio relativo al promedio, stock, urgencia y expectativas, con veredicto y gauge soja vs. dólares. Precios del día autocompletados.
- **📅 Historial:** gráfico de evolución **diaria** de dólar oficial y pizarra de soja, tabla de ventas por socio (planilla) y registros manuales.
- **⚙️ Mi situación:** sliders de stock/urgencia/expectativa y calculadora de equivalencia en pesos.

## Datos de precios (diarios)

El gráfico y los precios "de hoy" salen de [`prices.json`](prices.json), que regenera a diario [`scripts/update_prices.py`](scripts/update_prices.py) vía GitHub Action ([`update-prices.yml`](.github/workflows/update-prices.yml)).

| Serie | Fuente | Detalle |
|-------|--------|---------|
| Dólar Oficial $/USD | [dolarapi.com](https://dolarapi.com) (valor del día) · [ArgentinaDatos](https://argentinadatos.com) (backfill histórico) | Serie **diaria completa** |
| Soja pizarra Rosario $/tn | [Cámara Arbitral BCR](https://www.cac.bcr.com.ar/es/precios-de-pizarra) | Valor diario del día; ver nota abajo |

`prices.json` guarda `"history": [{ fecha, soja, dolar }, ...]` además de los campos snapshot (`soja`, `dolar`, `fecha`).

**Sobre la resolución de la soja:** no existe una fuente gratis con la pizarra Rosario diaria histórica en pesos, así que la serie arranca con anclas mensuales reales y **se densifica un punto real por día** a medida que corre el Action (no se interpolan ni estiman valores). El dólar, en cambio, es diario desde el inicio gracias al backfill.

El Action corre de lunes a viernes a las **18:30 ART** (`30 21 * * 1-5` UTC), después de que la CAC publica la pizarra del día.

## Cómo correrlo localmente

```bash
# Cualquier servidor estático (el fetch de prices.json necesita HTTP, no file://)
python3 -m http.server 8080
# o: npx serve .
```
