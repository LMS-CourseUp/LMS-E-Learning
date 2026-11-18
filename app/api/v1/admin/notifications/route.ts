import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import type { RowDataPacket } from "mysql2";
import { getRequestUser } from "@/lib/auth";
import { queryRows } from "@/lib/db";
import { json, readJson, safeString } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxRecipients = 1000;
const accountUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTags = [
  "a", "b", "blockquote", "br", "caption", "code", "del", "div", "em", "font", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "table",
  "tbody", "td", "th", "thead", "tr", "u", "ul",
];

type AccountRecipient = RowDataPacket & {
  uuid: string;
  username: string;
  email: string;
};

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeMessageHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      ol: ["start"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      "*": ["style"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        "background-color": [/^#[\da-f]{3}(?:[\da-f]{3})?$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
        color: [/^#[\da-f]{3}(?:[\da-f]{3})?$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
        "text-align": [/^(?:left|center|right|justify)$/],
      },
    },
  });
}

function smtpConfiguration() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT);
  const secureValue = process.env.SMTP_SECURE?.toLowerCase();
  const username = process.env.SMTP_USERNAME?.trim();
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM?.trim();

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 ||
    (secureValue !== "true" && secureValue !== "false") ||
    !username || !password || !from || !isEmail(from)) {
    return null;
  }

  return {
    host,
    port,
    secure: secureValue === "true",
    username,
    password,
    from,
    fromName: process.env.SMTP_FROM_NAME?.trim() || "CourseUp",
  };
}

function getSmtpDiagnostic(error: unknown) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  const responseCode = error instanceof Error && "responseCode" in error && typeof error.responseCode === "number"
    ? error.responseCode
    : null;
  const rawCommand = error instanceof Error && "command" in error && typeof error.command === "string" ? error.command : "";
  const command = /^[A-Z ]{1,32}$/.test(rawCommand) ? rawCommand : "UNKNOWN";
  return { code, responseCode, command };
}

function smtpErrorMessage({ code, responseCode, command }: ReturnType<typeof getSmtpDiagnostic>) {
  if (code === "EAUTH" || responseCode === 535 || command.startsWith("AUTH")) {
    return "SMTP menolak autentikasi. Periksa alamat mailbox, password mailbox, dan izin SMTP AUTH di ArenHost.";
  }
  if (code === "EDNS" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "SMTP_HOST tidak dapat ditemukan lewat DNS. Gunakan hostname SMTP yang persis dari panel ArenHost.";
  }
  if (["ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ETLS"].includes(code)) {
    return "Koneksi SMTP/TLS gagal. Cocokkan port dan mode TLS ArenHost: biasanya 465 dengan SMTP_SECURE=true atau 587 dengan SMTP_SECURE=false.";
  }
  return `Verifikasi SMTP gagal (${code}${responseCode ? `/${responseCode}` : ""}, ${command}). Periksa konfigurasi di .env.local.`;
}

export async function POST(request: Request) {
  try {
    const user = await getRequestUser(request);
    if (!user) return json({ error: "Silakan masuk terlebih dahulu." }, 401);
    if (user.role !== "admin") return json({ error: "Akses tidak diizinkan." }, 403);

    const body = await readJson(request);
    const subject = safeString(body?.subject, 160).replace(/[\r\n]+/g, " ");
    const rawHtml = typeof body?.html === "string" ? body.html : "";
    const sendToAll = body?.send_to_all === true;
    const rawUuids = body?.account_uuids;

    if (!subject || !rawHtml.trim() || rawHtml.length > 100_000) {
      return json({ error: "Subjek dan isi pesan wajib diisi; isi pesan maksimal 100 KB." }, 422);
    }

    let accountUuids: string[] = [];
    if (!sendToAll) {
      if (!Array.isArray(rawUuids) || rawUuids.length === 0 || rawUuids.length > maxRecipients ||
        rawUuids.some((uuid) => typeof uuid !== "string" || !accountUuidPattern.test(uuid))) {
        return json({ error: `Pilih 1 sampai ${maxRecipients} penerima dengan ID akun yang valid.` }, 422);
      }
      accountUuids = rawUuids as string[];
      if (new Set(accountUuids).size !== accountUuids.length) {
        return json({ error: "Daftar penerima berisi pilihan duplikat." }, 422);
      }
    }

    const config = smtpConfiguration();
    if (!config) {
      return json({ error: "SMTP belum lengkap. Atur SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USERNAME, SMTP_PASSWORD, dan SMTP_FROM di .env.local." }, 503);
    }

    const recipients = sendToAll
      ? await queryRows<AccountRecipient[]>("SELECT account_uuid AS uuid, username, email FROM users ORDER BY id")
      : await queryRows<AccountRecipient[]>(
        `SELECT account_uuid AS uuid, username, email FROM users WHERE account_uuid IN (${accountUuids.map(() => "?").join(", ")}) ORDER BY id`,
        accountUuids,
      );

    if (!sendToAll && recipients.length !== accountUuids.length) {
      return json({ error: "Sebagian akun penerima tidak ditemukan. Perbarui daftar akun lalu coba lagi." }, 404);
    }
    if (!recipients.length) return json({ error: "Tidak ada akun penerima." }, 422);
    if (recipients.length > maxRecipients) {
      return json({ error: `Pengiriman dibatasi maksimal ${maxRecipients} akun per pesan.` }, 422);
    }

    const html = sanitizeMessageHtml(rawHtml);
    if (!html.trim()) return json({ error: "Isi pesan tidak berisi konten yang dapat dikirim." }, 422);
    const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
    const appUrl = "https://lms.xi-rekayasa.my.id";
    const emailHtml = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pesan dari CourseUp</title>
    <style>
      .email-message p { margin: 0 0 16px; }
      .email-message h1 { margin: 0 0 18px; padding-bottom: 12px; border-bottom: 1px solid #e5eaf0; color: #123e4c; font-size: 27px; line-height: 1.25; }
      .email-message h2 { margin: 26px 0 12px; color: #123e4c; font-size: 22px; line-height: 1.35; }
      .email-message h3, .email-message h4, .email-message h5, .email-message h6 { margin: 22px 0 10px; color: #1c5960; font-size: 17px; line-height: 1.4; }
      .email-message ul, .email-message ol { margin: 0 0 18px; padding-left: 26px; }
      .email-message li { margin: 7px 0; padding-left: 4px; }
      .email-message blockquote { margin: 20px 0; padding: 12px 18px; border-left: 4px solid #e4c96e; background-color: #f3f8f5; color: #52666d; }
      .email-message pre { overflow-x: auto; margin: 20px 0; padding: 16px 18px; border-radius: 8px; background-color: #17212b; color: #e2e8f0; font-family: Consolas, 'Courier New', monospace; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
      .email-message :not(pre) > code { padding: 2px 5px; border-radius: 4px; background-color: #eef4f3; color: #16766f; font-family: Consolas, 'Courier New', monospace; font-size: .92em; }
      .email-message a { color: #16766f; text-decoration: underline; }
      .email-message table { width: 100%; margin: 18px 0; border-collapse: collapse; }
      .email-message th, .email-message td { padding: 9px 11px; border: 1px solid #dce5e8; text-align: left; }
      .email-message th { background-color: #f3f8f5; color: #123e4c; }
      .email-message img { display: inline-block; max-width: 100%; height: auto; border-radius: 8px; }
      .email-message hr { height: 1px; margin: 24px 0; border: 0; background-color: #e5eaf0; }
      @media screen and (max-width: 600px) {
        .email-message h1 { font-size: 23px; }
        .email-message h2 { font-size: 20px; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#f3f6fa;font-family:Arial,Helvetica,sans-serif;color:#17212b">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f3f6fa">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0">
            <tr>
              <td style="padding:22px 28px;background-color:#123e4c;border-radius:14px 14px 0 0">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="54" valign="middle" style="width:54px;padding-right:12px">
                      <a href="${appUrl}" style="text-decoration:none">
                        <img src="${appUrl}/course-up-logo.png" width="48" height="48" alt="CourseUp" style="display:block;width:48px;height:48px;border:0;border-radius:10px">
                      </a>
                    </td>
                    <td valign="middle">
                      <div style="color:#ffffff;font-size:21px;font-weight:700;line-height:1.25">CourseUp</div>
                      <div style="padding-top:4px;color:#d4e5e8;font-size:12px;line-height:1.4">Platform Edukasi Terpadu</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:4px;background-color:#f4d985;font-size:0;line-height:0">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:30px 32px;background-color:#ffffff;border:1px solid #e5eaf0;border-top:0;line-height:1.7">
                <p style="margin:0 0 18px;color:#567078;font-size:11px;font-weight:700;letter-spacing:1.2px">PESAN UNTUK ANDA</p>
                <div class="email-message" style="color:#26343d;font-size:15px;line-height:1.75;overflow-wrap:break-word">${html}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px;background-color:#f8fafc;border:1px solid #e5eaf0;border-top:0;border-radius:0 0 14px 14px;text-align:center">
                <p style="margin:0 0 8px;color:#64748b;font-size:12px;line-height:1.6">Pesan ini dikirim oleh administrator CourseUp.</p>
                <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6">
                  Butuh bantuan?
                  <a href="${appUrl}/contact" style="color:#16766f;font-weight:700;text-decoration:underline">Hubungi tim CourseUp</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    const textWithFooter = `${text || "Pesan ini berisi gambar."}\n\nPesan ini dikirim oleh administrator CourseUp.\nHubungi tim CourseUp: ${appUrl}/contact`;
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });

    try {
      await transporter.verify();
    } catch (error) {
      const diagnostic = getSmtpDiagnostic(error);
      console.error("Admin notification SMTP verification failed:", diagnostic);
      transporter.close();
      return json({ error: smtpErrorMessage(diagnostic) }, 502);
    }

    const failures: { account_uuid: string; username: string; reason: string }[] = [];
    const validRecipients = recipients.filter((recipient) => isEmail(String(recipient.email ?? "").trim()));
    for (const recipient of recipients) {
      if (!isEmail(String(recipient.email ?? "").trim())) {
        failures.push({
          account_uuid: recipient.uuid,
          username: recipient.username,
          reason: "Alamat email tidak valid",
        });
      }
    }

    let nextRecipient = 0;
    const workers = Array.from({ length: Math.min(5, validRecipients.length) }, async () => {
      while (nextRecipient < validRecipients.length) {
        const recipient = validRecipients[nextRecipient];
        nextRecipient += 1;
        try {
          await transporter.sendMail({
            from: { name: config.fromName, address: config.from },
            to: String(recipient.email).trim(),
            subject,
            text: textWithFooter,
            html: emailHtml,
          });
        } catch (error) {
          failures.push({
            account_uuid: recipient.uuid,
            username: recipient.username,
            reason: "Email gagal dikirim",
          });
          console.error("Admin notification delivery failed:", {
            accountUuid: recipient.uuid,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    });

    await Promise.all(workers);
    transporter.close();
    return json({
      sent: validRecipients.length - failures.filter((failure) => failure.reason === "Email gagal dikirim").length,
      total: recipients.length,
      failed: failures,
    });
  } catch (error) {
    console.error("Admin notification API error:", error instanceof Error ? error.name : "UnknownError");
    return json({ error: "Pesan gagal diproses." }, 500);
  }
}
