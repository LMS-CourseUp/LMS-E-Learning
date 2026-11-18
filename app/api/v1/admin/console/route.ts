import type { RowDataPacket } from "mysql2/promise";
import { getRequestUser } from "@/lib/auth";
import { queryRows } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuditLogRow = RowDataPacket & {
  id: number;
  action: string;
  entity_type: string;
  entity_id: number | null;
  details: Record<string, unknown> | string | null;
  created_at: Date;
  actor_username: string | null;
};

export async function GET(request: Request) {
  try {
    const user = await getRequestUser(request);
    if (!user) return json({ error: "Silakan masuk terlebih dahulu." }, 401);
    if (user.role !== "admin") return json({ error: "Akses tidak diizinkan." }, 403);

    let database: "online" | "offline" = "online";
    try {
      await queryRows<RowDataPacket[]>("SELECT 1 AS connected");
    } catch (error) {
      database = "offline";
      console.error("Admin console database health check failed:", error);
    }

    let logs: AuditLogRow[] = [];
    let logsError: string | null = null;
    try {
      logs = await queryRows<AuditLogRow[]>(
        "SELECT l.id, l.action, l.entity_type, l.entity_id, l.details, l.created_at, u.username AS actor_username FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id ORDER BY l.created_at DESC LIMIT 100",
      );
    } catch (error) {
      logsError = "Log audit tidak dapat dimuat.";
      console.error("Admin console audit logs failed:", error);
    }

    const memory = process.memoryUsage();
    return json({
      status: {
        application: "online",
        environment: process.env.NODE_ENV ?? "unknown",
        node_version: process.version,
        uptime_seconds: Math.floor(process.uptime()),
        memory: {
          rss_mb: Math.round(memory.rss / 1024 / 1024),
          heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(memory.heapTotal / 1024 / 1024),
        },
        database,
        checked_at: new Date().toISOString(),
      },
      logs,
      logs_error: logsError,
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Admin console API error:", error);
    return json({ error: "Status konsol gagal dimuat." }, 500, { "Cache-Control": "no-store" });
  }
}
