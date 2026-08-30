# personal-invest

Monorepo personal de Fernando: un vault donde va entrando, modulo a modulo,
toda la vida en un sitio. Un solo login para todo.

## Modulos

| Carpeta | Que es | Deploy |
|---|---|---|
| `invest/` | Inversiones: cartera con P&L, watchlist, analisis con IA y noticias. Next.js + Turso + OpenRouter | Vercel, Root Directory = `invest` |
| `packages/auth/` | Auth compartido del vault: sesion JWT, hash de contrasena (scrypt) y rate limit de login. Lo consumen todos los modulos | No se deploya; se importa |

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

1. Crea la carpeta (`notas/`, por ejemplo) con su app Next.js y anadela a
   `workspaces` en el package.json raiz si usas un patron distinto a los ya
   listados.
2. En su package.json: `"@vault/auth": "*"` y en su next.config:
   `transpilePackages: ["@vault/auth"]` y `turbopack: { root: path.join(__dirname, "..") }`.
3. Copia de invest: `src/lib/auth.ts`, `src/lib/attempt-store.ts`,
   `src/proxy.ts`, la ruta `api/auth/` y la tabla `auth_attempts` del schema.
   Son el cableado fino; la logica vive en el paquete.
4. Nuevo proyecto en Vercel sobre este mismo repo, Root Directory = la
   carpeta nueva, y las mismas `AUTH_*` env vars que ya usa invest.

## Deploy en Vercel

Cada modulo es un proyecto de Vercel apuntando a este repo, cambiando solo el
**Root Directory**. La opcion "Include source files outside of the Root
Directory" (activada por defecto) es la que permite que el build vea
`packages/auth`. `npm install` se corre en la RAIZ del repo, no dentro del
modulo: el lockfile vive aqui.
