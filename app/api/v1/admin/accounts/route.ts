import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { getRequestUser } from "@/lib/auth";
import { execute, queryRows, transaction } from "@/lib/db";
import { json, readJson, safeString } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const accountUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBulkDelete = 1000;

async function roleGuard(request: Request) {
  const user = await getRequestUser(request);
  if (!user) return { response: json({ error: "Silakan masuk terlebih dahulu." }, 401) };
  if (user.role !== "admin") return { response: json({ error: "Akses tidak diizinkan." }, 403) };
  return { user };
}

function textField(data: Record<string, unknown>, field: string, maxLength = 5000) {
  return safeString(data[field], maxLength);
}

export async function GET(request: Request) {
  try {
    const guard = await roleGuard(request);
    if (guard.response) return guard.response;

    await execute("UPDATE users SET account_uuid = UUID() WHERE account_uuid IS NULL");
    const accounts = await queryRows<(RowDataPacket & { id: number })[]>(
      "SELECT id, account_uuid AS uuid, username, email, full_name, profile_photo, role, account_status, last_active_at, created_at FROM users ORDER BY created_at DESC",
    );
    return json({
      accounts: accounts.map(({ id, ...account }) => ({
        ...account,
        is_current_user: Number(id) === guard.user.id,
      })),
    });
  } catch (error) {
    console.error("Admin accounts list error:", error);
    return json({ error: "Permintaan gagal diproses." }, 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const guard = await roleGuard(request);
    if (guard.response) return guard.response;

    const body = await readJson(request);
    const uuids = body?.account_uuids;
    if (!Array.isArray(uuids) || uuids.length === 0 || uuids.length > maxBulkDelete ||
      uuids.some((uuid) => typeof uuid !== "string" || !accountUuidPattern.test(uuid))) {
      return json({ error: `Pilih 1 sampai ${maxBulkDelete} akun dengan UUID yang valid.` }, 422);
    }

    const accountUuids = uuids as string[];
    if (new Set(accountUuids).size !== accountUuids.length) {
      return json({ error: "Daftar akun berisi pilihan duplikat." }, 422);
    }

    const placeholders = accountUuids.map(() => "?").join(", ");
    const result = await transaction(async (connection) => {
      const [accounts] = await connection.execute<(RowDataPacket & {
        id: number;
        uuid: string;
        role: "admin" | "student";
        account_status: "active" | "suspended";
      })[]>(
        `SELECT id, account_uuid AS uuid, role, account_status FROM users WHERE account_uuid IN (${placeholders}) FOR UPDATE`,
        accountUuids,
      );

      if (accounts.length !== accountUuids.length) return { error: "missing" as const };
      if (accounts.some((account) => Number(account.id) === guard.user.id)) return { error: "self" as const };

      const [activeAdmins] = await connection.execute<(RowDataPacket & { id: number })[]>(
        "SELECT id FROM users WHERE role = 'admin' AND account_status = 'active' FOR UPDATE",
      );
      const selectedActiveAdmins = accounts.filter((account) => account.role === "admin" && account.account_status === "active").length;
      if (activeAdmins.length <= selectedActiveAdmins) return { error: "last_admin" as const };

      const [deleteResult] = await connection.execute<ResultSetHeader>(
        `DELETE FROM users WHERE account_uuid IN (${placeholders})`,
        accountUuids,
      );
      if (deleteResult.affectedRows !== accountUuids.length) {
        throw new Error("Bulk account delete did not remove the complete selection.");
      }

      return { deleted: deleteResult.affectedRows, deleted_uuids: accounts.map((account) => account.uuid) };
    });

    if ("error" in result) {
      if (result.error === "missing") return json({ error: "Sebagian akun tidak ditemukan; tidak ada akun yang dihapus." }, 404);
      if (result.error === "self") return json({ error: "Akun yang sedang digunakan tidak dapat dihapus." }, 422);
      return json({ error: "Penghapusan dibatalkan agar minimal satu admin aktif tetap tersedia." }, 422);
    }

    return json({ success: true, ...result });
  } catch (error) {
    console.error("Admin bulk delete accounts error:", error);
    return json({ error: "Akun gagal dihapus. Tidak ada perubahan yang diterapkan." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const guard = await roleGuard(request);
    if (guard.response) return guard.response;

    const body = await readJson(request);
    const username = textField(body ?? {}, "username", 100);
    const email = textField(body ?? {}, "email", 150).toLowerCase();
    const fullName = textField(body ?? {}, "full_name", 150);
    const password = safeString(body?.password, 256);
    const role = String(body?.role ?? "student");

    if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || !["student", "admin"].includes(role)) {
      return json({ error: "Username, email, password, dan role wajib valid." }, 422);
    }

    const existing = await queryRows<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1", [username, email]);
    if (existing.length) return json({ error: "Username atau email sudah digunakan." }, 409);

    const result = await execute(
      "INSERT INTO users (account_uuid, username, email, password, full_name, profile_photo, role, account_status) VALUES (?, ?, ?, ?, ?, '', ?, 'active')",
      [randomUUID(), username, email, await bcrypt.hash(password, 12), fullName, role],
    );

    return json({ success: true, id: result.insertId }, 201);
  } catch (error) {
    console.error("Admin create account error:", error);
    return json({ error: "Permintaan gagal diproses." }, 500);
  }
}
