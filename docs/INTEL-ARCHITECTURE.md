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
- **Crons**: precios (15 min en mercado), sync (6 h), snapshot diario, noticias +
  filings (4 h), eventos (4 h, media hora despues), fundamentales (diario).

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
| Ingesta multi-fuente      | Parcial  | Finnhub (titulares + cripto etiquetada) y SEC EDGAR (filings). Sin RSS. |
| Tier de fiabilidad        | Hecho    | `intel/sources.ts`: 1..4 por fuente/host; tier 4 capado a P4.          |
| Deduplicacion por evento  | Hecho    | Lexica + semantica (`intel/dedup.ts`, `planMerge`); un evento por hecho.|
| Extraccion de eventos     | Hecho    | `intel/extract.ts`: evento estructurado y validado por cluster.         |
| Mapeo de empresas         | Parcial  | Solo simbolos ya seguidos; relevancia real desde el motor de P&L.       |
| Grafo de relaciones       | Falta    | Sin proveedores/clientes/competidores; sin efectos de 2o/3er orden.     |
| Pipeline por etapas       | Hecho    | Cron cada 4 h + ejecucion manual; etapas separadas en `intel/`.         |
| Motor de tesis            | Hecho    | Supuestos con estado, rompe-tesis, propuestas desde eventos, historial. |
| Score de senal            | Hecho    | `intel/score.ts`: pesos calibrables, techos, P1..P5.                    |
| Alertas P1-P5             | Parcial  | Tabla, generacion y UI (`/invest/alertas`). Falta notificar fuera.      |
| Hecho / inferencia / esp. | Hecho    | Columnas `fact` / `inference` / `assessment`, etiquetadas en la UI.      |
| Citas de evidencia        | Hecho    | `event_sources`: cada evento enlaza sus noticias con tier.              |
| Memoria acumulativa       | Parcial  | La tesis acumula estado por supuesto; sin deteccion de patrones aun.    |
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
     cerrojo en settings    una sola pasada a la vez (cron y manual no se pisan)
[1] filtro sin IA            descarta > 14 dias, sin ticker seguido, impact=low, > 3 intentos.
                             SIN resumen todavia → espera (la puerta barata falla cerrada)
[2] sources.ts               tier 1..4 por host (sufijo exacto) o nombre (palabra completa):
                             1 reguladores/filings · 2 Reuters/BBG/FT/WSJ/CNBC y wires oficiales
                             · 3 resto/desconocido · 4 social. Tier 4 NUNCA es hecho.
[3] dedup.ts                 clusters lexicos (ticker + ventana 72 h + Jaccard >= 0.5) con
                             ANCLAS: lo parecido a una noticia ya consumida (72 h) se engancha
                             a su evento sin IA → una historia en dos pasadas = un evento
[4] extract.planMerge        1 llamada barata: parafrasis → mismo cluster; engancha a eventos
                             P1-P4 de los ultimos 5 dias. Plan validado: solo fusiona con ticker
                             comun, solo engancha con empresa comun y dentro de ventana
[5] extract.extractEvent     1 llamada de analisis POR CLUSTER (tope 12/pasada, 200 s de
                             pasada, 75 s por llamada, <= 12 fuentes por prompt). Salida Zod:
                             type · companies (solo seguidos) · headline · fact / inference /
                             assessment · materiality · confidence · thesis_impact · horizon ·
                             is_noise. Antes de llamar se comprueba si la clave ya existe.
                             Si un enganche trae mejor tier que el evento (tuit → Reuters),
                             se REANALIZA con todas las fuentes y se repuntua
[6] score.ts                 portfolioRelevance (peso real en cartera / watchlist / conocido)
                             + scoreSignal (pesos calibrables + techos) → P1..P5
[7] events + event_sources   evento unico por cluster_key; cada evento cita sus noticias;
                             settings.intel_last_run guarda la ultima pasada (cron o manual)
[8] /invest/alertas          feed con hecho / inferencia / evaluacion separados, fuentes con
                             tier, estado de la ultima pasada y feedback (util · no util ·
                             ya lo sabia · especulativo · tarde · irrelevante)
```

### Tablas (migraciones `0003_intel_events.sql` y `0004_intel_attempts.sql`)

- `events`: el objeto analitico central. Un hecho, muchas fuentes. Guarda el
  modelo y la version del prompt que lo produjo (`model`, `prompt_version`)
  y el feedback del usuario.
- `event_sources`: evidencia. Que noticias respaldan cada evento.
- `news.event_processed_at`: marca de consumo por el motor (o de descarte).
- `news.event_attempts`: fallos acumulados; al tercero la noticia se abandona
  en vez de bloquear cada pasada. Indice parcial `news_event_pending_idx`.

### Score de senal

```
score = 0.30·materiality + 0.20·confidence + 0.25·|thesis_impact|
      + 0.15·portfolio_relevance + 0.10·fiabilidad(tier)     (tier: 100/85/60/25)

relevancia: posicion → 40 + 3·peso% (tope 100) · watchlist 40 · conocido 15 · resto 0
techos:  is_noise → <= 20 · solo tier 4 → <= 45 · confidence < 30 → <= 50
         · una sola fuente tier 3/4 (un host) → <= 64 (nunca P1/P2 sin corroboracion)
prioridad: >= 80 P1 · >= 65 P2 · >= 50 P3 · >= 35 P4 · resto P5 (no se muestra por defecto)
```

Pesos, techos y umbrales estan en `score.ts` (`SIGNAL_WEIGHTS`, `SCORE_CAPS`,
`PRIORITY_THRESHOLDS`). Se recalibran con el feedback guardado en `events`.

### Fallos del modelo: que pasa con cada uno

| Fallo | Que hace el motor | Cuenta intento |
| --- | --- | --- |
| Salida que no cumple el esquema (`invalid`) | sigue con el siguiente cluster | si |
| 4xx del proveedor (`rejected`: moderacion, modelo inexistente, prompt rechazado) | si aun no hubo ningun exito en la pasada, para (huele a configuracion); si ya hubo, salta el cluster | si |
| 429 / 5xx / red (`transient`) | para la pasada; lo pendiente se reintenta en la siguiente | no |
| Timeout por llamada | para la pasada | si |

El error queda en `RunStats.error`, persistido en `settings.intel_last_run`,
visible en la pagina de Alertas, en los logs y en el codigo de respuesta del
cron (502 cuando el modelo no respondio o rechazo todo).

### Decisiones y por que

- **Eventos, no titulares.** Cuatro medios contando lo mismo son UN evento con
  cuatro evidencias. Es la unica forma de que "muchas alertas" no sea el
  producto.
- **Dedup antes de IA, en tres capas.** Lexica con anclas (gratis y
  determinista, tambien entre pasadas), semantica (una llamada barata por
  pasada) y clave unica en la base. La IA cara solo ve clusters ya agrupados
  y nunca un hecho ya registrado.
- **Hecho / inferencia / evaluacion en columnas separadas**, no en un texto.
  Asi la UI puede mostrarlas con etiqueta y el usuario ve que es dato y que
  es opinion del modelo.
- **Todo lo que entra al modelo es dato, no instruccion.** Titulares,
  resumenes y nombres de fuente se aplanan (sin saltos de linea ni caracteres
  de control), se acotan y van entre «» con la advertencia explicita; el
  prompt lleva los tiers y la regla de que el tier 4 no sustenta hechos.
- **Salida estructurada, validada y saneada.** Zod estricto en enums, booleanos
  y rangos; tolerante en lo cosmetico (decimales se redondean, textos se
  recortan). Simbolos fuera de la lista seguida se descartan (si no queda
  ninguno valen los tickers del cluster); ruido declarado fuerza
  `thesis_impact = 0`; una frase con recomendacion de operar en la evaluacion
  se retira.
- **Una fuente floja no hace una alerta.** Con una sola fuente tier 3/4 el
  score no pasa de P3 por mucho que el modelo se entusiasme.
- **Relevancia de cartera calculada, no preguntada al modelo.** Sale del
  motor de P&L real con precios en cache (sin gastar cuota ni tiempo).
- **Nada de comprar/vender.** El prompt lo prohibe, el saneado lo filtra y la
  UI no tiene ningun boton de accion. Una alerta P1 dice "esto puede romper
  la tesis", no "vende".
- **Salud/biotech solo a nivel de negocio.** Regla explicita en el prompt.
- **Coste acotado por diseno.** Por pasada: <= 60 noticias, 1 llamada barata,
  <= 12 llamadas de analisis, 200 s. Con 6 pasadas/dia el techo son 72
  llamadas de analisis; el cerrojo evita que una pasada manual duplique el
  gasto de la del cron.

### Como se prueba

- `npm run test:intel`: 129 comprobaciones sin red sobre las etapas puras
  (tiers, tokens, clusters y anclas, plan de fusion y sus guardas, score y
  techos, relevancia, esquema, saneado, filtro de recomendaciones,
  clasificacion de errores, prompt e inyeccion).
- `npm run test:intel:db`: 66 comprobaciones contra SQLite local con las
  migraciones reales y la IA sustituida por funciones inyectadas: filtro que
  falla cerrado, extraccion e insercion, anclas entre pasadas, intentos y
  abandono, corte por error transitorio, rechazo con y sin exitos previos,
  reanalisis con evidencia mejor, cerrojo, choque de simbolos, feed,
  feedback y clave unica.
- `npm test` corre todo (P&L, IBKR, intel, intel:db).

### Que NO hace todavia

- No notifica fuera de la app (Telegram/email). El feed y las prioridades ya
  estan; la entrega es la siguiente pieza.
- No actualiza las tesis con los eventos ni guarda historial de cambios.
- No hay grafo de relaciones (proveedores, clientes, competidores) ni efectos
  de segundo orden: `companies` solo puede contener simbolos que ya sigues.
- Una sola fuente de ingesta (Finnhub). Sin RSS ni filings/SEC directos.
- El feedback se guarda pero aun no recalibra los pesos automaticamente.
- La dedup lexica no distingue antonimos ("beats" vs "misses" en el mismo
  dia se agrupan); el modelo de extraccion recibe ambos titulares y debe
  reportar la contradiccion en `fact`.

---

## 4. Iteracion 2 (hecha): tesis con supuestos, fuentes primarias y calibracion

Lo que faltaba para que el motor hiciera algo parecido a fundamental: un
objeto contra el que contrastar los eventos, datos primarios en vez de
titulares, y una forma de saber si las alertas sirven.

### Tesis estructurada (`src/lib/thesis.ts`, `/api/theses`, pestana Tesis)

- `theses.structure` (JSON: resumen, bull, bear, breakers, watch) +
  `thesis_assumptions` (supuestos medibles: metric, statement, target,
  comparator, unit, **status** on_track / at_risk / broken / unknown) +
  `thesis_changes` (historial y propuestas: generated / manual / proposal,
  pending / accepted / rejected / applied).
- Generacion con `generateObject` (modelo de analisis) y contexto real:
  posicion, fundamentales de Finnhub, eventos P1-P3 recientes y la tesis
  previa (el prompt exige actualizar, no reinventar). Al guardar, los
  supuestos se casan por `metric` para conservar estado e historial.
- **Bucle con el motor**: un evento P1-P3 con |thesis_impact| >= 40 sobre un
  activo con tesis dispara una llamada de contraste (`THESIS_CHECK_SYSTEM`)
  que propone cambios de estado por supuesto, si se cumple un rompe-tesis y
  un delta de conviccion. Se guarda como propuesta **pendiente**; nada se
  aplica hasta que el usuario acepta. Reglas: "broken" solo con hechos,
  nunca con inferencias; eventos tier 4 o P4/P5 no proponen; una propuesta
  por evento; tope de 4 por pasada.
- El markdown de `theses.thesis` se regenera con los estados, asi que el chat
  sigue viendo la tesis actual.

### Fuentes primarias

- **SEC EDGAR** (`src/lib/edgar.ts`): ticker → CIK con `company_tickers.json`
  (cacheado, guardado en `assets.cik`), `submissions` por empresa, filings de
  los ultimos 14 dias de los formularios 8-K, 10-K, 10-Q, 20-F, 6-K, SC 13D.
  Los 8-K se clasifican por items (2.02 resultados, 5.02 directivos, 1.01
  acuerdo material...; solo 9.01 o 5.07 se descartan). Se descarga el
  documento principal (y el anexo 99 si la carta es boilerplate), se pasa a
  texto y se guarda en `news.body` (kind = filing, fuente SEC EDGAR, tier 1,
  impacto por item, ya "resumido" sin IA). En el prompt de extraccion entran
  hasta 2 extractos de 3.000 caracteres. Requiere `SEC_CONTACT_EMAIL` (la SEC
  exige identificarse en el User-Agent). Maximo 8 documentos por pasada.
- **Fundamentales** (`src/lib/fundamentals.ts`, cron diario
  `/api/cron/fundamentals`): `/stock/metric`, `/stock/earnings` y
  `/calendar/earnings` de Finnhub, normalizados a un conjunto estable
  (P/E, P/S, P/B, crecimiento, margenes, ROE, deuda/equity, yield, rango
  52s) con nulls cuando no hay dato: nada se inventa. Entran en la tesis y en
  el prompt de eventos como una linea compacta.
- **Cripto**: las noticias de la categoria cripto de Finnhub se etiquetan por
  nombre completo o simbolo (>= 3 letras, palabra entera); nombres que son
  palabras corrientes (Optimism, Render, Near...) solo por simbolo. Un
  simbolo de 2 letras con nombre ambiguo queda sin cobertura: limite
  conocido.
- **Resumen de noticias**: si el modelo rapido falla, se reintenta el lote con
  el de analisis; el ultimo error queda en `settings.news_last_error` y se
  muestra en Noticias. `/api/models` comprueba que los ids configurados
  existen en el catalogo y Ajustes lo avisa.

### Calibracion (`src/lib/intel/calibration.ts`, `/api/intel/calibration`)

- Informe: eventos valorados por prioridad, utiles y desglose por tipo de
  feedback; precision = utiles / valorados.
- Pesos del score sobrescribibles en `settings.intel_weights`; el motor los
  carga en cada pasada. Sugerencia automatica solo con >= 30 valorados y >= 5
  de cada clase: separacion media (utiles − no utiles) por componente,
  normalizada con suelo 0.05. Se aplica o se restaura desde Alertas →
  Calibracion. Con pocas muestras no se sugiere nada: sobreajustar cinco
  pesos con veinte votos seria peor que dejarlos.

### Como se prueba (iteracion 2)

- `npm run test:sources`: 67 comprobaciones sin red: HTML→texto de EDGAR
  (iXBRL, entidades, tablas), submissions y clasificacion de filings,
  normalizacion de metricas y texto de fundamentales, etiquetado cripto,
  esquema/render/saneado de tesis, prompt de contraste y propuesta,
  calibracion (informe, sugerencia con suelo, pesos a mano).
- `test:intel:db` ampliado a 94: tesis guardada y re-guardada conservando
  estados, propuesta desde un evento material con IA inyectada, no
  duplicacion, rechazar/aceptar (estado, nota, conviccion, markdown), filing
  con extracto y fundamentales en el prompt, evento tier 1.

### Que sigue sin hacer

- Notificacion fuera de la app (Telegram/email) para P1/P2 y propuestas.
- Los supuestos con target numerico no se contrastan automaticamente contra
  los fundamentales (p. ej. margen operativo real vs >= 28%); hoy lo hace el
  modelo al contrastar eventos. Un chequeo deterministico trimestral es la
  siguiente pieza barata.
- Transcripciones de llamadas de resultados y estimaciones de consenso
  (de pago).

---

## 5. Siguiente iteracion recomendada

1. **Chequeo deterministico de supuestos**: tras cada refresco de
   fundamentales, comparar `target`/`comparator` con la metrica real y
   proponer at_risk/broken sin IA.
2. **Notificacion** (Telegram) de P1/P2 y de propuestas pendientes.
3. **Segunda fuente de titulares** con tickers (o RSS de IR) detras de una
   interfaz `NewsProvider`.
