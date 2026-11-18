"use client";

import { upload as uploadBlob } from "@vercel/blob/client";
import { Check, Mail, Search, Send, Trash2, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import MarkdownEditor from "@/components/admin/markdown-editor";
import { apiRequest } from "@/lib/browser-api";

type Account = {
  uuid: string;
  username: string;
  email: string;
  full_name: string;
  role: "admin" | "student";
  account_status: "active" | "suspended";
};

type DeliveryResult = {
  sent: number;
  total: number;
  failed: { account_uuid: string; username: string; reason: string }[];
};

const draftStorageKey = "courseup-admin-email-draft";

function getApiStatus(error: unknown) {
  return error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const [draftError, setDraftError] = useState("");
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [selectedUuids, setSelectedUuids] = useState<Set<string>>(new Set());
  const [sendToAll, setSendToAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deliveryResult, setDeliveryResult] = useState<DeliveryResult | null>(null);

  useEffect(() => {
    let active = true;
    apiRequest<{ accounts: Account[] }>("/api/v1/admin/accounts").then(({ accounts: result }) => {
      if (active) {
        setAccounts(result);
        setAccountsLoading(false);
      }
    }).catch((requestError) => {
      if (!active) return;
      const status = getApiStatus(requestError);
      if (status === 401) router.replace("/login");
      else if (status === 403) router.replace("/dashboard");
      else setAccountsError(requestError instanceof Error ? requestError.message : "Daftar akun gagal dimuat.");
      setAccountsLoading(false);
    });
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = window.localStorage.getItem(draftStorageKey);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const draft = parsed as Record<string, unknown>;
            if (typeof draft.subject === "string") setSubject(draft.subject.slice(0, 160));
            if (typeof draft.html === "string") setHtml(draft.html.slice(0, 100_000));
          }
        }
      } catch (loadError) {
        console.error("Admin notification draft load failed:", loadError);
        setDraftError("Draf lokal tidak dapat dibaca.");
        setDraftStatus("error");
      } finally {
        setDraftReady(true);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => {
        if (!active) return;
        try {
          window.localStorage.setItem(draftStorageKey, JSON.stringify({ subject, html }));
          setDraftError("");
          setDraftStatus("saved");
        } catch (saveError) {
          console.error("Admin notification draft save failed:", saveError);
          setDraftError("Draf tidak dapat disimpan di browser ini.");
          setDraftStatus("error");
        }
      });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftReady, html, subject]);

  useEffect(() => {
    if (!recipientsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) setRecipientsOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [recipientsOpen, sending]);

  const filteredAccounts = useMemo(() => {
    const term = recipientSearch.trim().toLocaleLowerCase("id-ID");
    return accounts.filter((account) => !term || `${account.full_name} ${account.username} ${account.email}`.toLocaleLowerCase("id-ID").includes(term));
  }, [accounts, recipientSearch]);
  const selectedCount = accounts.filter((account) => selectedUuids.has(account.uuid)).length;
  const selectedVisibleCount = filteredAccounts.filter((account) => selectedUuids.has(account.uuid)).length;
  const allVisibleSelected = filteredAccounts.length > 0 && selectedVisibleCount === filteredAccounts.length;
  const recipientCount = sendToAll ? accounts.length : selectedCount;

  const uploadNotificationImage = useCallback(async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 2 * 1024 * 1024) {
      throw new Error("Gambar harus JPG, PNG, atau WebP dengan ukuran maksimal 2 MB.");
    }
    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "").slice(-80) || "image";
    const blob = await uploadBlob(`notifications/${Date.now()}-${filename}`, file, {
      access: "public",
      handleUploadUrl: "/api/v1/blob-upload",
      clientPayload: JSON.stringify({ purpose: "admin-notification" }),
    });
    return blob.url;
  }, []);

  function toggleVisibleRecipients() {
    setSelectedUuids((current) => {
      const next = new Set(current);
      for (const account of filteredAccounts) {
        if (allVisibleSelected) next.delete(account.uuid);
        else next.add(account.uuid);
      }
      return next;
    });
  }

  function toggleRecipient(uuid: string, checked: boolean) {
    setSelectedUuids((current) => {
      const next = new Set(current);
      if (checked) next.add(uuid);
      else next.delete(uuid);
      return next;
    });
  }

  function clearDraft() {
    if (!window.confirm("Hapus draf pesan yang tersimpan di browser ini?")) return;
    try {
      window.localStorage.removeItem(draftStorageKey);
      setSubject("");
      setHtml("");
      setDraftError("");
      setDraftStatus("saved");
    } catch (clearError) {
      console.error("Admin notification draft clear failed:", clearError);
      setDraftError("Draf lokal gagal dihapus.");
      setDraftStatus("error");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!subject.trim() || !html.trim()) {
      setError("Subjek dan isi pesan wajib diisi.");
      return;
    }
    if (!recipientCount || recipientCount > 1000) {
      setError("Pilih 1 sampai 1000 akun penerima.");
      return;
    }
    if (!window.confirm(`Kirim pesan "${subject.trim()}" ke ${recipientCount} akun? Email yang sudah terkirim tidak dapat ditarik kembali.`)) return;

    setSending(true);
    setError("");
    setNotice("");
    setDeliveryResult(null);
    try {
      const result = await apiRequest<DeliveryResult>("/api/v1/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          html,
          send_to_all: sendToAll,
          account_uuids: sendToAll ? [] : Array.from(selectedUuids),
        }),
      });
      setDeliveryResult(result);
      if (result.failed.length) {
        setSendToAll(false);
        setSelectedUuids(new Set(result.failed.map((recipient) => recipient.account_uuid)));
        setNotice(`Terkirim ke ${result.sent} dari ${result.total} akun. Penerima gagal ditandai untuk dicoba ulang.`);
      } else {
        setNotice(`Pesan berhasil dikirim ke ${result.sent} akun.`);
        setRecipientsOpen(false);
      }
    } catch (requestError) {
      const status = getApiStatus(requestError);
      if (status === 401) router.replace("/login");
      else if (status === 403) router.replace("/dashboard");
      setError(requestError instanceof Error ? requestError.message : "Pesan gagal dikirim.");
    } finally {
      setSending(false);
    }
  }

  return <div className="admin-page">
    <header className="page-heading admin-heading">
      <span className="eyebrow">PESAN ADMIN</span>
      <h1 className="page-title">Notifikasi Email</h1>
      <p className="page-intro">Tulis pesan, pilih penerima dari akun terdaftar, lalu kirim melalui SMTP.</p>
    </header>
    {notice && <p className="status" role="status">{notice}</p>}
    {error && !recipientsOpen && <p className="status status-error" role="alert">{error}</p>}
    {accountsError && <p className="status status-error" role="alert">{accountsError}</p>}
    {draftError && <p className="status status-error" role="alert">{draftError}</p>}
    {deliveryResult?.failed.length ? <section className="notification-failed-list" aria-live="polite">
      <strong>Pengiriman gagal ({deliveryResult.failed.length})</strong>
      {deliveryResult.failed.map((recipient) => <span key={recipient.account_uuid}>{recipient.username}: {recipient.reason}</span>)}
    </section> : null}
    <section className="surface surface-pad admin-section notification-composer">
      <div className="admin-section-heading">
        <div><span className="list-meta">KOMPOSER</span><h2 className="surface-title"><Mail size={17} />Buat pesan email</h2></div>
        <span className={`notification-draft-state${draftStatus === "error" ? " is-error" : ""}`} role="status">{!draftReady ? "Memuat draf..." : draftStatus === "saving" ? "Menyimpan draf..." : draftStatus === "error" ? "Draf gagal disimpan" : "Draf tersimpan lokal"}</span>
      </div>
      <form className="notification-compose-form" onSubmit={(event) => {
        event.preventDefault();
        setError("");
        setRecipientsOpen(true);
      }}>
        <label className="field"><span>Subjek email</span><input className="input" value={subject} onChange={(event) => { setSubject(event.target.value); setDraftStatus("saving"); }} maxLength={160} required placeholder="Contoh: Pengumuman kelas minggu ini" /></label>
        <div className="field notification-editor-field"><span>Isi pesan</span><MarkdownEditor name="notification-message" value={html} onChange={(value) => { setHtml(value); setDraftStatus("saving"); }} onUploadImage={uploadNotificationImage} /></div>
        <div className="notification-compose-actions">
          <button type="button" className="button button-secondary" disabled={!draftReady} onClick={clearDraft}><Trash2 size={15} />Hapus draf</button>
          <button type="submit" className="button button-primary" disabled={!draftReady || accountsLoading || !accounts.length}><Users size={15} />Pilih penerima &amp; lanjutkan</button>
        </div>
      </form>
    </section>

    {recipientsOpen && <div className="notification-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !sending) setRecipientsOpen(false);
    }}>
      <section className="notification-dialog" role="dialog" aria-modal="true" aria-labelledby="notification-recipient-title">
        <header className="notification-dialog-header">
          <div><span className="list-meta">PILIH PENERIMA</span><h2 id="notification-recipient-title">Kirim notifikasi</h2></div>
          <button type="button" className="notification-dialog-close" aria-label="Tutup" disabled={sending} onClick={() => setRecipientsOpen(false)}><X size={19} /></button>
        </header>
        <form onSubmit={(event) => void sendMessage(event)}>
          <label className="notification-send-all"><input type="checkbox" checked={sendToAll} disabled={sending || accountsLoading || !accounts.length} onChange={(event) => setSendToAll(event.target.checked)} /><span><strong>Kirim ke semua akun</strong><small>{accounts.length} akun terdaftar akan menerima email</small></span><Check size={17} aria-hidden="true" /></label>
          <label className="account-search notification-recipient-search"><Search size={16} /><input className="input" value={recipientSearch} onChange={(event) => setRecipientSearch(event.target.value)} placeholder="Cari nama, username, atau email" aria-label="Cari penerima" /></label>
          <div className="notification-recipient-toolbar">
            <label><input type="checkbox" checked={allVisibleSelected} ref={(element) => { if (element) element.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected; }} disabled={sendToAll || sending || !filteredAccounts.length} onChange={toggleVisibleRecipients} />Pilih semua yang tampil</label>
            <span>{recipientCount} penerima dipilih</span>
          </div>
          <div className="notification-recipient-list" aria-label="Daftar akun penerima">
            {accountsLoading ? <p className="empty-state">Memuat daftar akun...</p> : filteredAccounts.length ? filteredAccounts.map((account) => <label className="notification-recipient-row" key={account.uuid}>
              <input type="checkbox" checked={sendToAll || selectedUuids.has(account.uuid)} disabled={sendToAll || sending} onChange={(event) => toggleRecipient(account.uuid, event.target.checked)} aria-label={`Pilih ${account.username}`} />
              <span className="notification-recipient-copy"><strong>{account.full_name || account.username}</strong><small>{account.email || "Email belum diisi"} · @{account.username}</small></span>
              <span className={`account-role account-role-${account.role}`}>{account.role === "admin" ? "Admin" : "Student"}</span>
              {account.account_status === "suspended" && <span className="account-state account-state-suspended">Nonaktif</span>}
            </label>) : <p className="empty-state">Tidak ada akun yang cocok.</p>}
          </div>
          {error && <p className="status status-error notification-dialog-error" role="alert">{error}</p>}
          {deliveryResult?.failed.length ? <div className="notification-dialog-result" role="status">
            <strong>Terkirim {deliveryResult.sent} dari {deliveryResult.total} email. Penerima gagal ditandai untuk dicoba ulang.</strong>
            {deliveryResult.failed.map((recipient) => <span key={recipient.account_uuid}>{recipient.username}: {recipient.reason}</span>)}
          </div> : null}
          <footer className="notification-dialog-actions">
            <button type="button" className="button button-secondary" disabled={sending} onClick={() => setRecipientsOpen(false)}>Kembali ke pesan</button>
            <button type="submit" className="button button-primary" disabled={sending || accountsLoading || !recipientCount || recipientCount > 1000}><Send size={15} />{sending ? "Mengirim email..." : `Kirim ${recipientCount} email`}</button>
          </footer>
          {recipientCount > 1000 && <p className="notification-recipient-limit" role="alert">Batas pengiriman adalah 1.000 akun per pesan. Kurangi pilihan atau kirim bertahap.</p>}
        </form>
      </section>
    </div>}
  </div>;
}
