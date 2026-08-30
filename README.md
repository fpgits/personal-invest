# personal-invest

Monorepo personal de Fernando: un vault donde va entrando, modulo a modulo,
toda la vida en un sitio. Un solo login para todo.

## Modulos

| Carpeta | Que es | Deploy |
|---|---|---|
| `home/` | El portal: la puerta del vault. Login unico y home con una tarjeta por modulo. Proxyea cada modulo bajo su ruta | Vercel, Root Directory = `home`. Es el dominio principal |
| `invest/` | Inversiones: cartera con P&L, watchlist, analisis con IA y noticias. Se sirve como zona bajo `/invest` | Vercel, Root Directory = `invest` |
| `packages/auth/` | Auth compartido del vault: sesion JWT, hash de contrasena (scrypt) y rate limit de login | No se deploya; se importa |

## Arquitectura: todo debajo del login

El portal es el unico dominio que visitas. Su raiz es el home con las
tarjetas; sin sesion, el guardian te manda a `/login`. Cada modulo corre como
proyecto propio de Vercel pero se sirve A TRAVES del portal (multi-zona):
`/invest/*` se proxyea al deployment de invest, que esta construido con
`basePath: "/invest"`.

Como todo se sirve bajo un solo dominio, la cookie de sesion del portal cubre
el vault completo: un login, todo dentro. Funciona ya en *.vercel.app, sin
esperar dominio propio. Y el acceso directo a la URL del deployment de un
modulo rebota al login del portal (`AUTH_LOGIN_URL`), asi que no hay puerta
trasera.

Cada modulo es autocontenido (su package.json, su DB, su README), pero el
login es uno solo: misma contrasena, misma cookie, mismo formato de sesion.

## Como funciona el login compartido

`packages/auth` (`@vault/auth`) contiene todo el auth. Cada modulo lo importa
via npm workspaces y le cablea su base de datos para el rate limit. Las tres
piezas que lo hacen "un solo login":

- `AUTH_PASSWORD_HASH`: el hash de TU contrasena. El mismo valor en las env
  vars de todos los proyectos de Vercel.
- `AUTH_SECRET`: firma las sesiones. El mismo valor en todos los proyectos;
  es lo que hace que una sesion emitida por un modulo la acepte otro.
- Cookie `__Secure-vault_session` (en produccion), con el mismo nombre en
  todos los modulos.

Estado actual y futuro:

- **Hoy, en \*.vercel.app**: cada modulo pide login una vez, con la misma
  contrasena. Las sesiones no se comparten entre modulos porque el navegador
  no permite cookies de dominio compartido en vercel.app (esta en la Public
  Suffix List). Es una limitacion del dominio, no del codigo.
- **Con dominio propio**: pones cada modulo en un subdominio
  (invest.tudominio.com, notas.tudominio.com), anades
  `AUTH_COOKIE_DOMAIN=".tudominio.com"` a todos los proyectos, y el login
  pasa a ser una sola sesion para todo el vault. El codigo ya lo soporta.

## Seguridad

- Contrasena nunca almacenada: scrypt con salt, comparacion en tiempo
  constante. El hash va en env vars, nunca en el repo.
- Rate limit de login persistido en la DB del modulo: 10 fallos por IP cada
  15 minutos (responde 429). En serverless un contador en memoria no limita
  nada; por eso vive en la base de datos.
- Cookie httpOnly + Secure + SameSite=Lax con prefijo `__Secure-` en
  produccion.
- Headers en todas las respuestas: X-Frame-Options DENY, nosniff,
  Referrer-Policy, HSTS.
- Secretos de terceros (API keys de exchanges) cifrados con AES-256-GCM
  antes de tocar la DB.

## Crear el siguiente modulo

1. Crea la carpeta (`notas/`, por ejemplo) con su app Next.js; `workspaces`
   en el package.json raiz ya cubre las carpetas de primer nivel que anadas
   a la lista.
2. En su package.json: `"@vault/auth": "*"`. En su next.config:
   `basePath: "/notas"`, `transpilePackages: ["@vault/auth"]` y
   `turbopack: { root: path.join(__dirname, "..") }`.
3. Copia de invest el cableado fino: `src/lib/auth.ts`, `src/proxy.ts` (con
   el redirect a `AUTH_LOGIN_URL`) y el helper `api()` para los fetch de
   client components. La logica vive en `packages/auth`.
4. En el portal: anade la tarjeta en `home/src/app/page.tsx` (lista
   `MODULES`) y el rewrite en `home/next.config.ts` con su env
   (`NOTAS_URL`, siguiendo el patron de `INVEST_URL`).
5. Nuevo proyecto en Vercel sobre este mismo repo, Root Directory = la
   carpeta nueva, mismas `AUTH_*` env vars, y `AUTH_LOGIN_URL` apuntando al
   login del portal. Luego redeploy del portal (los rewrites se fijan en
   build).

## Deploy en Vercel

Dos proyectos sobre este mismo repo, en este orden:

1. **invest**: Root Directory = `invest`. Sus env vars de siempre, mas
   `AUTH_LOGIN_URL` = `https://<portal>.vercel.app/login` (se puede anadir
   despues del paso 2 y redeployar). Anota su URL de produccion.
2. **home** (el portal, tu dominio principal): Root Directory = `home`.
   Env vars: `AUTH_PASSWORD_HASH` y `AUTH_SECRET` (los mismos de invest),
   `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` (para el rate limit del login) e
   `INVEST_URL` = la URL de produccion de invest, sin barra final.

Los rewrites del portal se fijan en build: si cambias `INVEST_URL`, redeploy
del portal. Los cron de invest apuntan a `/invest/api/cron/*` (con el
basePath) y los dispara Vercel directo contra el proyecto invest.

La opcion "Include source files outside of the Root Directory" (activada por
defecto) es la que permite que cada build vea `packages/auth`. `npm install`
se corre en la RAIZ del repo: el lockfile vive aqui.
