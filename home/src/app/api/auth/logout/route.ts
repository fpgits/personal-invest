import { logout } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  await logout();
  return Response.json({ ok: true });
}
