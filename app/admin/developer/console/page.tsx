"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Terminal as TerminalIcon } from "lucide-react";
import { apiRequest } from "@/lib/browser-api";

type AuditLog = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: number | null;
  details: Record<string, unknown> | string | null;
  created_at: string;
  actor_username: string | null;
};

type ConsoleData = {
  status: {
    application: "online";
    environment: string;
    node_version: string;
    uptime_seconds: number;
    memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
    database: "online" | "offline";
    checked_at: string;
  };
  logs: AuditLog[];
  logs_error: string | null;
};

type ConsoleEntry = { id: number; type: "command" | "output" | "error"; text: string };

function getApiStatus(error: unknown) {
  return error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${days} hari ${hours} jam ${minutes} menit ${remainingSeconds} detik`;
}

function describeDetails(value: AuditLog["details"]) {
  if (!value) return "";
  let details = value;
  if (typeof details === "string") {
    try {
      const parsed: unknown = JSON.parse(details);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
      details = parsed as Record<string, unknown>;
    } catch {
      return "";
    }
  }
  return Object.entries(details)
    .map(([key, item]) => key === "password_reset" ? (item ? "password reset" : "") : `${key.replaceAll("_", " ")}: ${String(item)}`)
    .filter(Boolean)
    .join(" · ");
}

function formatLog(log: AuditLog) {
  const when = new Date(log.created_at).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
  const target = `${log.entity_type}${log.entity_id ? ` #${log.entity_id}` : ""}`;
  const details = describeDetails(log.details);
  return `${when}  ${log.actor_username ?? "Akun dihapus"}  ${log.action.replaceAll(".", " · ")}  ${target}${details ? `  ${details}` : ""}`;
}

export default function DeveloperConsolePage() {
  const router = useRouter();
  const [data, setData] = useState<ConsoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [entries, setEntries] = useState<ConsoleEntry[]>([
    { id: 1, type: "output", text: "CourseUp Admin Ops Console · read-only" },
    { id: 2, type: "output", text: 'Ketik "help" untuk melihat perintah yang tersedia.' },
  ]);
  const entryId = useRef(2);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    return apiRequest<ConsoleData>("/api/v1/admin/console");
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await fetchData();
        if (active) {
          setData(result);
          setLoadError("");
          setLoading(false);
        }
      } catch (error) {
        if (!active) return;
        const status = getApiStatus(error);
        if (status === 401) router.replace("/login");
        else if (status === 403) router.replace("/dashboard");
        else setLoadError(error instanceof Error ? error.message : "Data konsol gagal dimuat.");
        setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [fetchData, router]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [entries]);

  function append(type: ConsoleEntry["type"], text: string) {
    entryId.current += 1;
    setEntries((current) => [...current.slice(-198), { id: entryId.current, type, text }]);
  }

  async function refreshNow() {
    setRefreshing(true);
    try {
      const result = await fetchData();
      setData(result);
      setLoadError("");
      append("output", `Data berhasil diperbarui · ${new Date(result.status.checked_at).toLocaleString("id-ID")}`);
    } catch (error) {
      const status = getApiStatus(error);
      if (status === 401) router.replace("/login");
      else if (status === 403) router.replace("/dashboard");
      append("error", error instanceof Error ? error.message : "Data konsol gagal dimuat.");
    } finally {
      setRefreshing(false);
    }
  }

  async function runCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = command.trim();
    if (!raw) return;
    setCommand("");
    setHistory((current) => [...current, raw]);
    setHistoryIndex(-1);
    append("command", `$ ${raw}`);

    const [name, ...args] = raw.split(/\s+/);
    switch (name.toLowerCase()) {
      case "help":
        append("output", [
          "Perintah yang tersedia:",
          "  help              Tampilkan bantuan",
          "  status            Status aplikasi, database, dan penggunaan memori",
          "  logs [jumlah]     Tampilkan log audit terbaru (1-100, default 20)",
          "  refresh           Ambil status dan log terbaru sekarang",
          "  clear             Bersihkan tampilan terminal",
          "Perintah hanya membaca data operasional; tidak menjalankan shell server.",
        ].join("\n"));
        break;
      case "status":
        if (!data) append("error", "Status belum tersedia. Coba perintah refresh.");
        else append("output", [
          `Aplikasi     : ${data.status.application.toUpperCase()}`,
          `Database     : ${data.status.database.toUpperCase()}`,
          `Environment  : ${data.status.environment}`,
          `Node.js      : ${data.status.node_version}`,
          `Uptime       : ${formatUptime(data.status.uptime_seconds)}`,
          `Memori RSS   : ${data.status.memory.rss_mb} MB`,
          `Heap         : ${data.status.memory.heap_used_mb} / ${data.status.memory.heap_total_mb} MB`,
          `Diperiksa    : ${new Date(data.status.checked_at).toLocaleString("id-ID")}`,
        ].join("\n"));
        break;
      case "logs": {
        const count = args.length === 0 ? 20 : Number(args[0]);
        if (args.length > 1 || !Number.isInteger(count) || count < 1 || count > 100) {
          append("error", "Format: logs [jumlah], jumlah harus 1-100.");
        } else if (data?.logs_error) {
          append("error", data.logs_error);
        } else if (!data) {
          append("error", "Log belum tersedia. Coba perintah refresh.");
        } else if (!data.logs.length) {
          append("output", "Belum ada log audit yang tercatat.");
        } else {
          append("output", data.logs.slice(0, count).map(formatLog).join("\n"));
        }
        break;
      }
      case "refresh":
        await refreshNow();
        break;
      case "clear":
        setEntries([]);
        break;
      default:
        append("error", `Perintah tidak dikenal: ${name}. Ketik "help".`);
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(0, historyIndex === -1 ? history.length - 1 : historyIndex - 1);
      setHistoryIndex(nextIndex);
      setCommand(history[nextIndex] ?? "");
    } else if (event.key === "ArrowDown" && historyIndex !== -1) {
      event.preventDefault();
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setCommand("");
      } else {
        setHistoryIndex(nextIndex);
        setCommand(history[nextIndex] ?? "");
      }
    }
  }

  return <div className="admin-page">
    <header className="page-heading admin-heading">
      <span className="eyebrow">ADMIN OPERATIONS</span>
      <h1 className="page-title">Terminal</h1>
      <p className="page-intro">Pantau status layanan dan log audit terbaru secara langsung.</p>
    </header>
    {loadError && <p className="status status-error" role="alert">{loadError}</p>}
    <section className="admin-terminal" aria-label="Terminal operasional admin">
      <div className="admin-terminal-toolbar">
        <div className="admin-terminal-title"><TerminalIcon size={16} /><strong>courseup-ops</strong><span>read-only</span></div>
        <div className="admin-terminal-health" aria-live="polite">
          <span className={data ? "is-online" : "is-offline"}><i />APP {data?.status.application.toUpperCase() ?? (loading ? "MEMUAT" : "OFFLINE")}</span>
          <span className={data?.status.database === "online" ? "is-online" : "is-offline"}><i />DB {data?.status.database.toUpperCase() ?? "—"}</span>
          <button type="button" className="admin-terminal-refresh" aria-label="Muat ulang status dan log" title="Muat ulang status dan log" disabled={refreshing} onClick={() => void refreshNow()}><RefreshCw size={15} className={refreshing ? "is-spinning" : undefined} /></button>
        </div>
      </div>
      <div className="admin-terminal-output" ref={outputRef} role="log" aria-live="polite" aria-label="Output terminal">
        {loading && <p className="admin-terminal-muted">Menghubungkan ke status server dan log audit...</p>}
        {entries.map((entry) => <pre className={`admin-terminal-entry is-${entry.type}`} key={entry.id}>{entry.text}</pre>)}
      </div>
      <form className="admin-terminal-prompt" onSubmit={(event) => void runCommand(event)}>
        <label htmlFor="admin-terminal-command">admin@courseup:~$</label>
        <input
          ref={inputRef}
          id="admin-terminal-command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={handleInputKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Masukkan perintah terminal"
          placeholder="ketik help..."
        />
        <button type="submit" disabled={!command.trim()} aria-label="Jalankan perintah">Jalankan</button>
      </form>
      <footer className="admin-terminal-footer">
        <span>Log audit terbarui otomatis tiap 30 detik</span>
        {data && <time dateTime={data.status.checked_at}>Pemeriksaan terakhir {new Date(data.status.checked_at).toLocaleTimeString("id-ID")}</time>}
      </footer>
    </section>
  </div>;
}
