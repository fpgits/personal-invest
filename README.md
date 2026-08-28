# Inversiones

Plataforma personal para seguir inversiones en bolsa y cripto: cartera con P&L,
watchlist, analisis con IA y noticias resumidas.

Un solo usuario. No es multi-tenant y no pretende serlo.

## Stack

| Pieza | Que se usa | Por que |
|---|---|---|
| Framework | Next.js 16 (App Router) + React 19 | RSC para las paginas pesadas de datos, route handlers para el resto |
| Base de datos | Turso (libSQL) + Drizzle ORM | Lo pediste. SQLite serverless encaja bien: el volumen es pequeno y casi todas las lecturas son por clave |
| IA | OpenRouter via AI SDK v7 | Lo pediste. El modelo se elige en `/ajustes` sin redesplegar |
| Precios de bolsa | Finnhub | Free tier: 60 req/min, US en tiempo real, uso personal |
| Precios de cripto | CoinGecko | Free: 5-15 req/min sin key, 30 con demo key gratis |
| Sync de exchanges | ccxt | Una integracion, ~100 exchanges |
| Graficos | Recharts | Paleta validada para daltonismo, ver `src/components/charts.tsx` |
| Deploy | Vercel | Lo pediste. Los cron de `vercel.json` mueven precios, sync, snapshots y noticias |

Auth: contrasena unica + JWT en cookie httpOnly (`jose`). Sin OAuth, sin tabla de
usuarios, sin proveedor externo.

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
| `AUTH_PASSWORD_HASH` | si | `npm run hash-password -- "tu-clave"` |
| `AUTH_SECRET` | si | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | si (para exchanges) | `openssl rand -base64 32`, exactamente 32 bytes |
| `OPENROUTER_API_KEY` | no | openrouter.ai/keys. Sin esto no hay IA |
| `FINNHUB_API_KEY` | no | finnhub.io/register. Sin esto no hay precios de acciones |
| `COINGECKO_API_KEY` | no | Opcional, sube el limite de 5-15 a 30 req/min |
| `CRON_SECRET` | no | `openssl rand -hex 32`. Vercel lo manda como `Authorization: Bearer` |

`ENCRYPTION_KEY` cifra las API keys de los exchanges. **Si la cambias, las
cuentas guardadas dejan de descifrarse y hay que volver a meterlas.**

## Como entran los datos

Tres vias, y se pueden mezclar:

1. **Sync automatico de exchanges.** En `/cuentas` conectas Binance, Bybit,
   Kraken, OKX, KuCoin, Coinbase, Bitget, MEXC, Gate.io o Crypto.com con una API
   key **de solo lectura**. La app solo llama a `fetchBalance` y `fetchMyTrades`.
   El cron `/api/cron/sync` lo repite cada 6 horas.
2. **Import CSV.** En `/cartera`. Reconoce las cabeceras mas comunes en ingles y
   espanol, acepta fechas europeas y americanas y numeros con coma o punto
   decimal. Hay vista previa antes de escribir nada, y reimportar el mismo
   archivo no duplica.
3. **A mano.** Formulario en `/cartera` para compras, ventas, dividendos,
   comisiones, depositos y retiros.

### Sobre el sync y el coste de entrada

El balance del exchange manda. Si el exchange dice que tienes 0.5 BTC pero el
historial de trades solo explica 0.3, la app crea un `transfer_in` de 0.2 con
**precio 0** en vez de inventarse un precio de entrada. Eso hace que ese trozo
aparezca como 100% de ganancia latente, que es lo honesto: no sabemos a cuanto
entro. Edita esa operacion a mano si conoces el precio real.

Para brokers de bolsa no hay sync automatico: no existe una API gratuita y
universal para eso. Usa el CSV que exporte tu broker.

## P&L

Dos metodos, se cambia en `/ajustes` y recalcula todo el historico al momento:

- **Coste medio** (por defecto): cada compra recalcula el medio, las ventas
  realizan contra ese medio.
- **FIFO**: se mantienen lotes y las ventas consumen los mas antiguos primero.

Las comisiones suman al coste en las compras y restan del ingreso en las ventas.
Los dividendos se acumulan aparte y no tocan la cantidad. Un `transfer_out` no
realiza P&L: el activo sigue siendo tuyo, solo cambio de sitio.

El motor tiene tests con cifras calculadas a mano:

```bash
npm run test:pnl
```

## Cron de Vercel

Definidos en `vercel.json`. Necesitan `CRON_SECRET` o devuelven 401.

| Ruta | Cuando | Que hace |
|---|---|---|
| `/api/cron/prices` | cada 15 min, 13-21h L-V | Refresca precios (horario de mercado US en UTC) |
| `/api/cron/sync` | cada 6 h | Sincroniza los exchanges conectados |
| `/api/cron/snapshot` | 22:05 diario | Guarda la foto del dia. **Sin esto no hay grafico historico** |
| `/api/cron/news` | cada 4 h | Trae titulares y los resume con el modelo rapido |

El plan Hobby de Vercel limita los cron a 2 al dia. Si estas en Hobby, deja
`snapshot` y `news` y refresca precios y sync a mano desde la UI.

## Sobre la IA

Los prompts (`src/lib/ai/prompts.ts`) estan escritos para que el modelo analice,
no para que recomiende. No dice que comprar ni que vender; describe
concentracion, riesgo y lo que no puede saber. Si le pides una tesis, escribe el
caso bajista tan fuerte como el alcista a proposito.

El catalogo de OpenRouter cambia cada semana, asi que no hay modelos
hardcodeados: `/ajustes` lee la lista en vivo y guarda tu eleccion en la base de
datos.

## Comandos

```bash
npm run dev            # desarrollo
npm run build          # build de produccion
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test:pnl       # tests del motor de P&L
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
                  noticias, analisis, cuentas, ajustes
    api/          route handlers, incluidos los cron
    login/
  components/     ui.tsx (primitivas), charts.tsx, nav.tsx, formularios
  db/             schema.ts (12 tablas) y cliente perezoso de libsql
  lib/
    portfolio.ts  motor de P&L, con tests
    market/       finnhub.ts, coingecko.ts y el router entre ambos
    exchanges/    ccxt.ts (conexion) y sync.ts (orquestacion)
    ai/           client.ts, context.ts, prompts.ts
    crypto.ts     AES-256-GCM para las API keys, scrypt para la contrasena
    csv.ts        parser tolerante de CSV de brokers
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
- No hay alertas por email ni push todavia. La watchlist guarda el precio
  objetivo pero no notifica.
