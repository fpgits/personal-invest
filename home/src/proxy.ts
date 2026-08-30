import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName, verifySessionToken } from "@vault/auth/session";

/**
 * La puerta del vault: todo lo que no sea /login exige sesion.
 * Las rutas /api se protegen ellas mismas.
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
    "/((?!api|_next/static|_next/image|favicon.ico|invest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
