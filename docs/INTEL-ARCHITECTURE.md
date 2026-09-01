# Inteligencia de inversion: arquitectura

Objetivo del producto: un equipo de research con IA, no un agregador de
noticias. `NOTICIA → EVENTO → IMPACTO → TESIS → ALERTA`, optimizando
**calidad de senal**, no cantidad de alertas. La app es de solo lectura:
observa y avisa; nunca opera.

Este documento es el mapa de lo que existe, lo que falta y en que orden se
construye. Se actualiza con cada iteracion.

---

## 1. Que existe (auditoria, sept 2026)

### Datos y sincronizacion (solidos, no tocar)
- **Turso + Drizzle**, 13 tablas: `assets, accounts, transactions, price_cache,
  snapshots, watchlist, news, theses, ai_threads, ai_messages, settings,
  sync_runs, auth_attempts`.
- **Sync de cuentas** (solo lectura): IBKR via Flex Web Service y Binance via
  ccxt. Reconciliacion contra el balance real (`lib/holdings.ts`), efectivo por
  cuenta (clase `cash`, atribuido al lado bolsa/cripto).
- **Precios**: Finnhub (bolsa) y CoinGecko (cripto), con cache y TTL por clase.
- **Motor de P&L** (`lib/portfolio.ts`): coste medio/FIFO, coste estimado para
  depositos sin precio, reparto por lado.
- **Crons**: precios (15 min en mercado), sync (6 h), snapshot diario, noticias (4 h),
  eventos (4 h, media hora despues de noticias).

### Ingesta de noticias (existe, pero es una sola fuente)
- `lib/news.ts` + `lib/market/finnhub.ts`: trae `company-news` de los activos
  que tienes o vigilas, mas `market-news` general. Dedupe **solo por URL**.
- Cada noticia se resume en lote con el modelo rapido: `summary`, `sentiment`
  (bullish/bearish/neutral), `impact` (high/medium/low), `tickers`.
- Se muestra en `/invest/noticias`.

### IA (existe, toda via OpenRouter)
- Un unico cliente (`lib/ai/client.ts`) con `@openrouter/ai-sdk-provider`.
  Modelos intercambiables desde Ajustes leyendo el catalogo en vivo.
- Funciones **bajo demanda** (las dispara el usuario): chat con contexto de la
  cartera, analisis de riesgo, tesis por activo (texto libre en markdown).
- Prompts analiticos, no prescriptivos (`lib/ai/prompts.ts`): dato vs opinion,
  nunca inventar cifras, no dice que comprar.

### Vigilancia (base, sin motor)
- `watchlist` guarda `targetPrice` y `alertDirection` (above/below), pero
  **nada genera ni entrega alertas** todavia.
- `theses` guarda una tesis por activo como texto, con conviccion y horizonte.
  No esta estructurada (sin bull/bear/supuestos/rompe-tesis) y **no se
  actualiza con eventos**.

---

## 2. Que falta (respecto al producto objetivo)

| Etapa del bucle           | Estado   | Detalle                                                                 |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| Ingesta multi-fuente      | Parcial  | Solo Finnhub. Sin proveedores modulares, sin RSS, sin filings/SEC.      |
| Tier de fiabilidad        | Hecho    | `intel/sources.ts`: 1..4 por fuente/host; tier 4 capado a P4.          |
| Deduplicacion por evento  | Hecho    | Lexica + semantica (`intel/dedup.ts`, `planMerge`); un evento por hecho.|
| Extraccion de eventos     | Hecho    | `intel/extract.ts`: evento estructurado y validado por cluster.         |
| Mapeo de empresas         | Parcial  | Solo simbolos ya seguidos; relevancia real desde el motor de P&L.       |
| Grafo de relaciones       | Falta    | Sin proveedores/clientes/competidores; sin efectos de 2o/3er orden.     |
| Pipeline por etapas       | Hecho    | Cron cada 4 h + ejecucion manual; etapas separadas en `intel/`.         |
| Motor de tesis            | Parcial  | Tesis en texto; sin estructura ni score de cambio de tesis.             |
| Score de senal            | Hecho    | `intel/score.ts`: pesos calibrables, techos, P1..P5.                    |
| Alertas P1-P5             | Parcial  | Tabla, generacion y UI (`/invest/alertas`). Falta notificar fuera.      |
| Hecho / inferencia / esp. | Hecho    | Columnas `fact` / `inference` / `assessment`, etiquetadas en la UI.      |
| Citas de evidencia        | Hecho    | `event_sources`: cada evento enlaza sus noticias con tier.              |
| Memoria acumulativa       | Falta    | Cada analisis es aislado; no detecta patrones semana a semana.          |
| Informe diario            | Falta    |                                                                         |
| Scorecards / descubrimiento | Falta  | Fases posteriores.                                                      |

---

## 3. Iteracion 1 (hecha): bucle minimo `noticia → evento → score → alerta`

Se reutilizan la ingesta y el cliente de IA existentes. El bucle vive en
`src/lib/intel/`, un modulo por etapa, para poder cambiar cualquier pieza
(incluido el proveedor de LLM, que sigue siendo OpenRouter) sin tocar el resto.

```
news (existente: Finnhub → resumen barato con impact/tickers)
  │
  ▼  lib/intel/run.ts        orquesta; cron /api/cron/events (30 */4) y POST /api/events
[1] filtro sin IA            descarta > 14 dias, sin ticker seguido, impact=low
[2] sources.ts               tier 1..4 por fuente/host (1 filings/wires · 2 Reuters/BBG/FT/WSJ/CNBC
                             · 3 resto/desconocido · 4 social). Tier 4 NUNCA es hecho.
[3] dedup.ts                 clusters lexicos (ticker + ventana 72 h + Jaccard >= 0.5)
[4] extract.planMerge        1 llamada barata: parafrasis → mismo cluster; engancha a eventos
                             de los ultimos 5 dias (alias E1..En). Plan validado, nunca fiado.
[5] extract.extractEvent     1 llamada de analisis POR CLUSTER (tope 12/pasada), salida Zod:
                             type · companies (solo simbolos seguidos) · headline ·
                             fact / inference / assessment · materiality · confidence ·
                             thesis_impact (-100..100) · time_horizon · is_noise
[6] score.ts                 portfolioRelevance (peso en cartera / watchlist / conocido)
                             + scoreSignal (pesos calibrables) → P1..P5
[7] events + event_sources   evento unico por cluster_key; cada evento cita sus noticias
[8] /invest/alertas          feed con hecho / inferencia / evaluacion separados, fuentes con
                             tier, y feedback (util · no util · ya lo sabia · especulativo ·
                             tarde · irrelevante)
```

### Tablas nuevas (migracion `drizzle/0003_intel_events.sql`)

- `events`: el objeto analitico central. Un hecho, muchas fuentes. Guarda el
  modelo y la version del prompt que lo produjo (`model`, `prompt_version`)
  y el feedback del usuario.
- `event_sources`: evidencia. Que noticias respaldan cada evento.
- `news.event_processed_at`: marca de consumo por el motor (o de descarte).

### Score de senal

```
score = 0.30·materiality + 0.20·confidence + 0.25·|thesis_impact|
      + 0.15·portfolio_relevance + 0.10·fiabilidad(tier)     (tier: 100/85/60/25)

techos: is_noise → <= 20 · solo tier 4 → <= 45 · confidence < 30 → <= 50
prioridad: >= 80 P1 · >= 65 P2 · >= 50 P3 · >= 35 P4 · resto P5 (no se muestra por defecto)
```

Pesos, techos y umbrales estan en `score.ts` (`SIGNAL_WEIGHTS`, `SCORE_CAPS`,
`PRIORITY_THRESHOLDS`). Se recalibran con el feedback guardado en `events`.

### Decisiones y por que

- **Eventos, no titulares.** Cuatro medios contando lo mismo son UN evento con
  cuatro evidencias. Es la unica forma de que "muchas alertas" no sea el
  producto.
- **Dedup antes de IA, en dos capas.** La lexica es gratis y determinista; la
  semantica cuesta una llamada barata por pasada y resuelve parafrasis. La IA
  cara solo ve clusters ya agrupados.
- **Hecho / inferencia / evaluacion en columnas separadas**, no en un texto.
  Asi la UI puede mostrarlas con etiqueta y el usuario ve que es dato y que
  es opinion del modelo.
- **Salida estructurada y validada (Zod) + saneado.** Simbolos fuera de la
  lista seguida se descartan; ruido declarado fuerza `thesis_impact = 0`.
  Una salida malformada se rechaza y se marca como consumida (no se reintenta
  en bucle); un fallo de red o de modelo corta la pasada y deja lo pendiente
  para el siguiente cron. El error queda en `RunStats.error`, visible en la
  UI ("Analizar ahora") y en los logs de Vercel.
- **Relevancia de cartera calculada, no preguntada al modelo.** Sale del
  motor de P&L real (`computePortfolio`), no de lo que el LLM crea.
- **Nada de comprar/vender.** El prompt lo prohibe y la UI no tiene ningun
  boton de accion. Una alerta P1 dice "esto puede romper la tesis", no "vende".
- **Salud/biotech solo a nivel de negocio.** Regla explicita en el prompt.
- **Coste acotado por diseno.** Por pasada: <= 60 noticias, 1 llamada barata,
  <= 12 llamadas de analisis. Con 6 pasadas/dia el techo son 72 llamadas de
  analisis, y en la practica la mayoria de noticias se descartan antes.

### Como se prueba

- `npm run test:intel`: 73 comprobaciones sin red sobre las etapas puras
  (tiers, tokens, clusters, plan de fusion, score, relevancia, esquema,
  saneado, prompt).
- `npm run test:intel:db`: 17 comprobaciones contra SQLite local aplicando las
  migraciones reales: filtro sin IA, idempotencia, feed, feedback, unicidad de
  `cluster_key`.
- `npm test` corre todo (P&L, IBKR, intel, intel:db).

### Que NO hace todavia

- No notifica fuera de la app (Telegram/email). El feed y las prioridades ya
  estan; la entrega es la siguiente pieza.
- No actualiza las tesis con los eventos ni guarda historial de cambios.
- No hay grafo de relaciones (proveedores, clientes, competidores) ni efectos
  de segundo orden: `companies` solo puede contener simbolos que ya sigues.
- Una sola fuente de ingesta (Finnhub). Sin RSS ni filings/SEC directos.
- El feedback se guarda pero aun no recalibra los pesos automaticamente.

---

## 4. Siguiente iteracion recomendada

**Entrega de alertas + tesis estructurada**, en este orden:

1. **Notificacion P1/P2** por Telegram (bot, un chat) desde `run.ts` al crear
   un evento >= P2. Es lo que convierte el feed en "hey, mira esto".
2. **Tesis estructurada** (`theses` → bull/bear/supuestos/rompe-tesis) y
   `thesis_changes`: cada evento con `|thesis_impact| >= 40` propone un cambio
   de tesis que el usuario acepta o rechaza. Con eso el motor deja de ser
   por-evento y empieza a acumular memoria por activo.
3. **Segunda fuente de ingesta** (RSS de comunicados/IR y SEC EDGAR para los
   tickers seguidos) detras de una interfaz `NewsProvider` comun.
