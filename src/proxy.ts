import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName, verifySessionToken } from "@/lib/vault/session";

/**
 * La puerta del vault: todo lo que no sea /login exige sesion.
 * Las rutas /api se protegen ellas mismas con requireAuth, porque deben
 * responder 401 en JSON en vez de redirigir.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isLogin = pathname === "/login";
  const cookie = sessionCookieName(process.env.NODE_ENV === "production");
  const token = req.cookies.get(cookie)?.value;

  const valid =
    Boolean(token) &&
    Boolean(process.env.AUTH_SECRET) &&
    (await verifySessionToken(token!, process.env.AUTH_SECRET!));

  if (!valid && !isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (valid && isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Todo menos: rutas de api, estaticos de next, favicon y assets publicos.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
