# Fernando Portela

El portal personal de Fernando: una sola app, un solo login, y dentro las
secciones de su vida. La primera es **Invest** (`/invest`): cartera con P&L,
watchlist, analisis con IA y noticias resumidas.

Un solo usuario. No es multi-tenant y no pretende serlo.

## Como esta organizado

- `/login` es la unica puerta. Sin sesion, el guardian (`src/proxy.ts`) manda
  ahi. Con sesion, la raiz `/` muestra el home con una tarjeta por seccion.
- Cada seccion vive bajo su ruta: `src/app/invest/*` con su layout propio.
  Anadir la siguiente seccion es crear su carpeta en `src/app/` y su tarjeta
  en `src/app/page.tsx`. Nada mas: mismo login, mismo deploy, misma DB o la
  suya propia.
- El auth vive en `src/lib/vault/` (sesion JWT, scrypt, rate limit) y el
  cableado en `src/lib/auth.ts`.

## Stack

| Pieza | Que se usa | Por que |
|---|---|---|
| Framework | Next.js 16 (App Router) + React 19 | RSC para las paginas pesadas de datos, route handlers para el resto |
| Base de datos | Turso (libSQL) + Drizzle ORM | Lo pediste. SQLite serverless encaja bien: el volumen es pequeno y casi todas las lecturas son por clave |
| IA | OpenRouter via AI SDK v7 | Lo pediste. El modelo se elige en `/ajustes` sin redesplegar |
| Precios de bolsa | Finnhub | Free tier: 60 req/min, US en tiempo real, uso personal |
| Precios de cripto | CoinGecko | Free: 5-15 req/min sin key, 30 con demo key gratis |
| Sync de exchanges | ccxt | Una integracion, ~100 exchanges. Binance incluido |
| Sync de broker | IBKR Flex Web Service | La unica API de IBKR que funciona sin TWS ni IB Gateway corriendo |
| Graficos | Recharts | Paleta validada para daltonismo, ver `src/components/charts.tsx` |
| Deploy | Vercel | Lo pediste. Los cron de `vercel.json` mueven precios, sync, snapshots y noticias |

Auth: `src/lib/vault/`: contrasena unica con scrypt, JWT en cookie httpOnly
`__Secure-vault_session` y rate limit de login en DB (10 fallos por IP cada
15 min). Sin OAuth, sin tabla de usuarios, sin proveedor externo. Un login
para todo el vault.

## Puesta en marcha

```bash
npm install
cp .env.example .env.local
npm run hash-password -- "tu-clave-de-12-o-mas"   # imprime todos los secretos
npm run db:push                                    # crea las tablas en Turso
npm run dev
```

### Variables de entorno

Las primeras son obligatorias; sin ellas la app arranca pero muestra una
pantalla diciendo exactamente que falta.

| Variable | Obligatoria | De donde sale |
|---|---|---|
| `TURSO_DATABASE_URL` | si | Panel de Turso, empieza por `libsql://` |
| `TURSO_AUTH_TOKEN` | si | `turso db tokens create personal-invest` |
| `AUTH_PASSWORD` o `AUTH_PASSWORD_HASH` | si (una de las dos) | La clave tal cual (sin `$`), o el hash de `npm run hash-password`. Con ambas, manda `AUTH_PASSWORD` |
| `AUTH_SECRET` | si | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | si (para exchanges) | `openssl rand -base64 32`, exactamente 32 bytes |
| `OPENROUTER_API_KEY` | no | openrouter.ai/keys. Sin esto no hay IA |
| `AI_DAILY_BUDGET_USD` | no | Tope diario en USD para las tareas de fondo de IA (defecto 2, 0 = sin limite). Editable en /ajustes |
| `FINNHUB_API_KEY` | no | finnhub.io/register. Sin esto no hay precios de acciones |
| `SEC_CONTACT_EMAIL` | no | Tu email, para el User-Agent que exige la SEC. Sin esto no se leen filings ni 13F de EDGAR |
| `OPENFIGI_API_KEY` | no | openfigi.com/api. Opcional: sube el limite de CUSIP → ticker de 25 a 250 req/min (Inversores) |
| `COINGECKO_API_KEY` | no | Opcional, sube el limite de 5-15 a 30 req/min |
| `FRED_API_KEY` | no | fredaccount.stlouisfed.org/apikey. Contexto macro (tipos, inflacion, desempleo) y tipo libre de riesgo. Sin clave, el panel macro no aparece |
| `CRON_SECRET` | no | `openssl rand -hex 32`. Vercel lo manda como `Authorization: Bearer` |

`ENCRYPTION_KEY` cifra las API keys de los exchanges. **Si la cambias, las
cuentas guardadas dejan de descifrarse y hay que volver a meterlas.**

## Como entran los datos

Tres vias, y se pueden mezclar:

1. **Interactive Brokers, automatico.** En `/cuentas`, pestana Broker. Usa el
   Flex Web Service: token mas Query ID, dos llamadas HTTPS, sin gateway.
2. **Exchanges de cripto, automatico.** Binance, Bybit, Kraken, OKX, KuCoin,
   Coinbase, Bitget, MEXC, Gate.io y Crypto.com, con API key **de solo
   lectura**. Solo se llama a `fetchBalance` y `fetchMyTrades`.
3. **CSV o a mano.** En `/cartera`, para cualquier cosa que no cubran los dos
   anteriores. El CSV reconoce cabeceras en ingles y espanol, fechas europeas y
   americanas, y numeros con coma o punto decimal.

El cron `/api/cron/sync` repite 1 y 2 cada 6 horas.

### Interactive Brokers: por que Flex y no la API "normal"

IBKR tiene tres APIs y dos no sirven aqui:

- **TWS API**: exige TWS o IB Gateway corriendo en una maquina, con socket
  abierto y sesion viva. Imposible en una funcion serverless.
- **Client Portal API**: exige el gateway local y reautenticacion cada 24h.
  Mismo problema.
- **Flex Web Service**: token mas Query ID, dos llamadas HTTPS, sin sesion.
  Es la que usa la app.

Montarlo en Client Portal:

1. **Performance & Reports** y luego **Flex Queries**.
2. Crea una **Activity Flex Query** con al menos **Trades** y **Open
   Positions**. Anade **Cash Transactions** para que entren los dividendos y
   tus **aportes/retiros de efectivo** (Deposits & Withdrawals → historial de
   capital), **Cash Report** para el saldo de efectivo y **Equity Summary
   in Base by Report Date** para que la reconstruccion del historico use el
   efectivo real de cada dia. Formato XML.
3. Apunta el **Query ID**.
4. En el engranaje de **Flex Web Service**, activalo y genera un token.
   **No le pongas restriccion por IP**: las funciones de Vercel no tienen IP
   fija y el token fallaria con el error 1013.

Limites de IBKR: 1 peticion por segundo y 10 por minuto por token. La app
espera y reintenta mientras el informe se genera (errores 1009 y 1019).

Lo que la Flex Query no cubre todavia: opciones, futuros y forex. El sync los
cuenta y te dice cuantas filas salto, en vez de meterlos mal.

### Binance y el bloqueo por region

Binance devuelve **HTTP 451** a las IPs de Estados Unidos, y las funciones de
Vercel corren por defecto en `iad1` (Washington). Por eso `vercel.json` fija
`"regions": ["fra1"]` (Frankfurt).

Dos consecuencias:

- En el plan Hobby solo se puede elegir **una** region, asi que todas las
  funciones corren en Frankfurt.
- Tu base de datos Turso esta en `aws-us-east-1`. Frankfurt a Virginia son unos
  90ms de ida y vuelta por consulta. Para un dashboard personal se nota poco,
  pero si quieres quitarlo, mueve la DB a un grupo europeo de Turso: esta
  vacia, recrearla no cuesta nada.

Tampoco pongas whitelist de IP en la API key de Binance, por la misma razon que
en IBKR: las IPs de salida de Vercel cambian.

### Sobre el coste de entrada en las reconciliaciones

Si el saldo que reporta la fuente no cuadra con las operaciones importadas, la
app crea un ajuste en vez de callarse:

- **IBKR** si da el coste medio en Open Positions, asi que el ajuste entra con
  su coste real.
- **Los exchanges no**, asi que ahi el ajuste entra con **precio 0**. Eso hace
  que ese trozo aparezca como 100% de ganancia latente, que es lo honesto: no
  sabemos a cuanto entro. Editalo a mano si lo sabes.

## P&L

Dos metodos, se cambia en `/ajustes` y recalcula todo el historico al momento:

- **Coste medio** (por defecto): cada compra recalcula el medio, las ventas
  realizan contra ese medio.
- **FIFO**: se mantienen lotes y las ventas consumen los mas antiguos primero.

Las comisiones suman al coste en las compras y restan del ingreso en las ventas.
Los dividendos se acumulan aparte y no tocan la cantidad. Un `transfer_out` no
realiza P&L: el activo sigue siendo tuyo, solo cambio de sitio.

### Aportes de capital

El efectivo que metes a una cuenta no es una ganancia, asi que va aparte del
P&L. La tabla `cash_flows` guarda el historial real de **aportes y retiros**
(con su fecha e importe verdaderos), separada de los plugs de reconciliacion de
`transactions` (que solo reflejan el saldo actual y se reescriben en cada sync).
De ahi sale el **capital neto aportado** (aportes − retiros) y el **retorno
sobre lo aportado** = valor actual − neto aportado, que ves en Cartera.

De donde sale el dato:

- **IBKR**: de la seccion **Cash Transactions** de la Flex Query, filas
  Deposits/Withdrawals. Fecha e importe exactos.
- **Exchange (Binance...)**: depositos/retiros de efectivo (fiat y stablecoins)
  via ccxt, **mejor esfuerzo**: la API limita cada consulta a ~90 dias, asi que
  el primer sync hace un barrido profundo y los siguientes solo la ventana
  reciente; el historial muy antiguo puede quedar incompleto. Mover cripto de
  inversion no cuenta como "cash inyectado". Todo con upsert idempotente.

El motor tiene tests con cifras calculadas a mano, y el parser de IBKR tiene
los suyos con XML de ejemplo con la forma real que devuelve Flex:

```bash
npm run test           # todos
npm run test:pnl
npm run test:ibkr
npm run test:intel     # motor de inteligencia, etapas puras
npm run test:sources   # EDGAR, fundamentales, cripto, tesis, calibracion
npm run test:managers  # inversores 13F, parseo y sync con EDGAR falso
npm run test:period    # periodo de revision y metricas por periodo
npm run test:history   # reconstruccion del historico (Stooq, CoinGecko, Equity Summary)
npm run test:ai        # politica de IA: presupuesto, contabilidad, recorte de contexto
npm run test:cashflows # aportes de capital: extraccion, neto aportado, retorno
npm run test:group     # filtro por grupo (bolsa/cripto/todo)
npm run test:macro     # contexto macro de FRED (parseo, curva, texto para IA)
npm run test:intel:db  # motor + tesis contra SQLite local
```

## Periodo de revision

Arriba a la derecha de Resumen, Cartera, Alertas y Noticias hay un selector de
periodo, el mismo en todas: presets (hoy, ayer, 7/30/90 dias, 6/12 meses,
mes, trimestre y ano en curso) o un rango a mano en el calendario, y un rango de
comparacion (periodo anterior, ano anterior, ano anterior por dia de la
semana, o uno a mano). La eleccion se guarda en una cookie (`invest_period`)
con las fechas ya resueltas por el navegador, asi que vale para todas las
paginas y sobrevive al recargar; el servidor solo la lee
(`src/lib/period.ts` es la logica pura, `src/lib/period-server.ts` la
cookie). En Resumen las metricas del periodo se piden a
`/api/portfolio/period` con el periodo elegido como clave (SWR), asi que lo
que se ve corresponde siempre al selector y mientras llega se ve un
esqueleto; el resto de paginas se vuelven a renderizar con la cookie nueva.

Que cambia con el periodo:

- **Resumen**: la tarjeta *Resultado* pasa a ser la del periodo:
  `P&L al final − P&L al inicio`, con P&L = no realizado + realizado +
  dividendos acumulados, asi que **un deposito sube el valor pero no el
  resultado**. El inicio es el cierre del dia anterior al periodo; el final es
  el ultimo cierre, o los precios en vivo si el periodo llega a hoy. Debajo,
  la comparacion ("vs 5 jul–3 ago: +1.7%"). El grafico tiene dos lecturas:
  *Resultado* (por defecto: lo que gano o perdio lo invertido desde el inicio
  del periodo, arranca en 0) y *Valor* (valor total con el capital aportado en
  discontinua; capital aportado = valor − P&L total, sube con un deposito y
  no con una subida). *Mejores y peores* pasa a ser la variacion de precio en
  el periodo.
- **Cartera**: la lista de operaciones se filtra al periodo.
- **Alertas** y **Noticias**: se filtran por fecha del hecho / de publicacion.

Todo sale de los snapshots diarios (`/api/cron/snapshot`), asi que el
historico empieza el dia del primer snapshot **fiable**: las fotos vacias
(cuenta recien creada) o con precios a 0 (proveedor caido) se ignoran, porque
compararse con ellas presentaria depositos como ganancia. Un periodo que
empiece antes se mide desde ese dia y lo dice en la tarjeta ("historico desde
1 sept"); una comparacion sin snapshots dice "sin historico". Las pestanas
Bolsa/Cripto necesitan snapshots de esta version o posterior (guardan el
realizado por lado); con snapshots viejos el resultado por lado no se muestra,
el total si.

### Historico reconstruido

El cron nocturno solo guarda la foto si las posiciones que importan tienen
precio (si no, reintenta tres veces y, si sigue sin precios, no guarda nada:
mejor un hueco que una foto falsa). Los huecos, y todo lo anterior al primer
snapshot, se rellenan desde **Ajustes → Historico de la cartera → Reconstruir
historico** (`POST /api/history`, `src/lib/history.ts`): para cada dia hasta
ayer se vuelve a jugar el libro de operaciones con el mismo motor de P&L y se
valora con los cierres de ese dia, Stooq (CSV publico, sin clave) para
acciones y ETF y CoinGecko para cripto (hasta 365 dias atras). Un dia sin
cierre (fin de semana, festivo) usa el ultimo cierre anterior; un activo sin
serie usa su ultimo precio de operacion y queda listado en el informe. El
efectivo de dias pasados no esta en el libro (los ajustes de cuadre llevan la
fecha del sync), asi que sale de la seccion **Equity Summary in Base** de la
Flex Query de IBKR si la tienes activada (Client Portal → Performance &
Reports → Flex Queries → editar la query → marcar "Equity Summary in Base by
Report Date"); si no, se asume el saldo actual, constante. Nada de esto cambia
el resultado (variacion del P&L): solo el valor y el capital aportado. Las
fotos reconstruidas llevan `source = rebuilt` y se pueden regenerar cuantas
veces se quiera; una foto en vivo fiable nunca se pisa.

Los ajustes de cuadre que crea cada sync (saldo de efectivo, diferencias con
Open Positions) entran al coste 1:1 o al coste real del broker, nunca como
ganancia, y no aparecen en la lista de operaciones.

## Deploy

Un solo proyecto de Vercel (`personal-invest`) apuntando a la raiz del repo.
**Root Directory vacio** (el valor por defecto): la app vive en la raiz.

## Cron de Vercel

Definidos en `vercel.json`. Necesitan `CRON_SECRET` o devuelven 401.

| Ruta | Cuando | Que hace |
|---|---|---|
| `/api/cron/prices` | cada 15 min, 13-21h L-V | Refresca precios (horario de mercado US en UTC) |
| `/api/cron/sync` | cada 6 h | Sincroniza los exchanges conectados |
| `/api/cron/snapshot` | 22:05 diario | Guarda la foto del dia. **Sin esto no hay grafico historico** |
| `/api/cron/news` | cada 4 h | Titulares (Finnhub) + filings (SEC EDGAR), y resumen con el modelo rapido |
| `/api/cron/events` | cada 4 h, a y media | Convierte noticias en eventos con score y prioridad, y propone cambios de tesis (ver `docs/INTEL-ARCHITECTURE.md`) |
| `/api/cron/fundamentals` | 06:45 diario | Fundamentales basicos de las acciones (Finnhub) y 13F nuevos de los gestores seguidos (SEC EDGAR) |

Estos horarios (cada 15 min, cada 4h, cada 6h) requieren el plan Pro de
Vercel. En Hobby, cualquier cron mas frecuente que diario hace fallar el
deploy; si algun dia bajas a Hobby, deja los cuatro pero en version diaria.

### Refinamiento opcional en Pro

Con Pro se pueden fijar regiones por funcion. Lo optimo seria: todo en `iad1`
(pegado a Turso) y solo las rutas que llaman a Binance en `fra1`. No viene
activado porque el patron de `functions` en vercel.json no se puede verificar
sin desplegar; si quieres probarlo despues del primer deploy verde:

```json
"regions": ["iad1"],
"functions": {
  "src/app/api/cron/sync/route.ts": { "regions": ["fra1"] },
  "src/app/api/accounts/*/sync/route.ts": { "regions": ["fra1"] },
  "src/app/api/accounts/*/test/route.ts": { "regions": ["fra1"] }
}
```

Si el build se queja de que el patron no coincide, quitalo y vuelve al
`"regions": ["fra1"]` global, que funciona seguro.

## Sobre la IA

Los prompts (`src/lib/ai/prompts.ts`) estan escritos para que el modelo analice,
no para que recomiende. No dice que comprar ni que vender; describe
concentracion, riesgo y lo que no puede saber. Si le pides una tesis, escribe el
caso bajista tan fuerte como el alcista a proposito.

El catalogo de OpenRouter cambia cada semana, asi que no hay modelos
hardcodeados: `/ajustes` lee la lista en vivo y guarda tu eleccion en la base de
datos.

### Coste y control de gasto

Toda llamada a OpenRouter pasa por una sola puerta (`src/lib/ai/client.ts`:
`aiObject`, `aiText`, `aiStream`) que aplica la politica de `src/lib/ai/policy.ts`.
Esa tabla, editable en un sitio, fija por tipo de llamada el modelo (rapido o de
analisis), el tope de tokens de salida, el esfuerzo de razonamiento y el timeout:

| Tipo | Modelo | Salida | Razonamiento | Fondo |
|---|---|---|---|---|
| Resumen de noticias | rapido | 2000 | bajo | si |
| Agrupacion (merge) | rapido | 800 | bajo | si |
| Extraccion de eventos | analisis | 2500 | medio | si |
| Contraste con tesis | analisis | 2000 | medio | si |
| Borrador de tesis | analisis | 4000 | — | no |
| Tesis en texto | analisis | 2500 | — | no |
| Riesgo | analisis | 2500 | — | no |
| Chat | analisis | 3000 | — | no |

Cada llamada, buena o mala, deja una fila en `ai_calls` con tokens y coste. El
coste sale de la contabilidad de uso de OpenRouter (`usage: { include: true }`),
que viene en la propia respuesta sin una peticion extra; si el proveedor no lo
devuelve, se estima con el precio del catalogo, y si tampoco hay precio queda a 0
marcado como desconocido. `/ajustes` → **Uso de IA** muestra hoy, 7 y 30 dias,
el desglose por tipo y los ultimos fallos.

**Presupuesto diario** (`AI_DAILY_BUDGET_USD`, por defecto 2 USD; se puede
cambiar en `/ajustes` sin redeploy, 0 = sin limite). Solo frena el **trabajo de
fondo** (resumenes, eventos, propuestas): cuando el gasto del dia (UTC) llega al
tope, los crons se paran y siguen al dia siguiente. El chat, el riesgo y las
tesis que pides a mano nunca se bloquean.

**Ahorro estructural**, ademas de los topes: el resumen de noticias solo
reintenta lo que fallo una vez al dia y mientras es reciente (antes reenviaba
todo cada 4 h con dos modelos); un fallo transitorio no se reintenta con el
modelo caro; el contexto del chat se cachea 10 min y se marca con
`cache_control` para que los proveedores con cache de prompt lo cobren a
fraccion de precio; el historial del chat se acota a ~16k caracteres; y el
modelo configurado se lee de la base de datos como mucho una vez por minuto en
vez de en cada llamada.

## Comandos

```bash
npm run dev            # desarrollo
npm run build          # build de produccion
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # todos los tests (P&L, IBKR, inteligencia, fuentes, inversores, IA)
npm run db:generate    # genera migracion SQL desde el schema
npm run db:push        # aplica el schema a Turso
npm run db:studio      # explorador de la base de datos
npm run hash-password  # genera AUTH_PASSWORD_HASH y los demas secretos
```

## Estructura

```
src/
  app/
    (app)/        paginas con sesion: resumen, cartera, watchlist,
                  alertas, noticias, inversores, analisis, cuentas, ajustes
    api/          route handlers, incluidos los cron
    login/
  components/     ui.tsx (primitivas), charts.tsx, nav.tsx, formularios
  db/             schema.ts (24 tablas, incl. ai_calls y cash_flows) y cliente perezoso de libsql
  lib/
    portfolio.ts  motor de P&L, con tests
    cashflows.ts  aportes/retiros de efectivo: extraccion (IBKR/exchange), neto aportado, retorno
    period.ts     periodo de revision (presets, comparacion, cookie) y period-metrics.ts (resultado por periodo)
    history.ts    reconstruccion del historico con cierres diarios (market/stooq.ts, CoinGecko) y Equity Summary de IBKR
    market/       finnhub.ts, coingecko.ts, fred.ts (macro) y el router entre ambos
    macro.ts      contexto macro de FRED: tipos, inflacion, desempleo, curva 10-2 y tipo libre de riesgo
    sync.ts       enruta cada cuenta a su integracion
    exchanges/    ccxt.ts (conexion) y sync.ts (cripto)
    brokers/      ibkr.ts (Flex Web Service) y sync.ts (bolsa)
    ai/           client.ts (puerta unica + contabilidad + presupuesto), policy.ts (topes por tipo), errors.ts, context.ts, prompts.ts
    intel/        motor de inteligencia: sources, dedup, extract, score, run, calibration
    thesis.ts     tesis estructurada: supuestos, propuestas desde eventos, historial
    edgar.ts      SEC EDGAR: CIK, filings, texto de 8-K/10-Q
    managers.ts   inversores seguidos: 13F de EDGAR, diff trimestral, eventos tier 1
    fundamentals.ts  ratios y resultados de Finnhub
    crypto.ts     AES-256-GCM para las API keys, scrypt para la contrasena
  proxy.ts        guarda de sesion (antes middleware.ts)
```

## Limites conocidos

- La moneda base es una etiqueta, no convierte. Todo se valora en USD.
- Las velas historicas de acciones estan capadas en el free tier de Finnhub, asi
  que el grafico de la cartera sale de los snapshots diarios propios y necesita
  un par de dias para tener forma.
- El sync de cripto prueba los pares mas comunes (USDT, USD, USDC, EUR, BTC).
  Si operaste en un par raro, ese trade entra por la reconciliacion de balance
  con coste desconocido.
- De IBKR se importan acciones y fondos. Opciones, futuros y forex se saltan y
  se reportan, no se importan mal.
- Las operaciones en moneda distinta de USD se guardan con su moneda, pero la
  valoracion sigue siendo en USD.
- No hay alertas por email ni push todavia. La watchlist guarda el precio
  objetivo pero no notifica.
