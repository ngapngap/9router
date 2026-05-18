"use client";

import { useEffect, useState } from "react";
import { Card, Button } from "@/shared/components";
import Link from "next/link";

export default function AccountPage() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [err, setErr] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setErr("");
      try {
        const [meRes, tokRes] = await Promise.all([
          fetch("/api/account/me"),
          fetch("/api/account/tokens"),
        ]);
        if (cancelled) return;
        if (meRes.status === 404) {
          setErr("Account page chỉ dùng khi bật SaaS (SAAS_ENABLED).");
          setLoading(false);
          return;
        }
        if (!meRes.ok) {
          const j = await meRes.json().catch(() => ({}));
          setErr(j.error || `Error ${meRes.status}`);
          setLoading(false);
          return;
        }
        const profile = await meRes.json();
        setMe(profile);
        if (tokRes.ok) {
          const t = await tokRes.json();
          setTokens(t.items || []);
        }
      } catch (e) {
        if (!cancelled) setErr("Không tải được dữ liệu.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleExport = async () => {
    setExporting(true);
    setErr("");
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || "Export thất bại.");
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const name = m ? m[1] : "ramrouter-export.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr("Export thất bại.");
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-text-muted">Loading…</p>
      </div>
    );
  }

  if (err && !me) {
    return (
      <div className="p-6 max-w-lg">
        <p className="text-text-muted">{err}</p>
        <Link href="/dashboard/profile" className="text-primary text-sm mt-4 inline-block">
          Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="text-sm text-text-muted mt-1">
          Thông tin đọc từ New-API (Postgres). Quản lý mật khẩu và API key tạo tại New-API — không đổi được ở đây.
        </p>
      </div>

      {err && (
        <p className="text-sm text-amber-600 dark:text-amber-400" role="alert">
          {err}
        </p>
      )}

      <Card>
        <h2 className="text-base font-medium mb-3">Profile</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-text-muted">ID</dt>
            <dd>{me?.id}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Username</dt>
            <dd className="break-all">{me?.username ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Email</dt>
            <dd className="break-all">{me?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Display name</dt>
            <dd>{me?.displayName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Role</dt>
            <dd>{me?.role ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Quota</dt>
            <dd>
              {me?.usedQuota != null && me?.quota != null
                ? `${me.usedQuota} / ${me.quota}`
                : "—"}
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="text-base font-medium mb-2">API keys (New-API)</h2>
        <p className="text-xs text-text-muted mb-3">
          Key hiển thị che một phần. Tạo hoặc thu hồi key trong New-API.
        </p>
        {tokens.length === 0 ? (
          <p className="text-sm text-text-muted">Chưa có token hoặc không có bản ghi hiển thị.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {tokens.map((t) => (
              <li key={t.id} className="px-3 py-2 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <span className="font-medium">{t.name || `Token ${t.id}`}</span>
                <span className="font-mono text-xs text-text-muted">{t.maskedKey}</span>
                <span className="text-text-muted text-xs">status {t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-medium mb-2">Export router config</h2>
        <p className="text-sm text-text-muted mb-4">
          Tải JSON cấu hình dashboard (SQLite riêng theo user) — dùng backup hoặc chuyển máy.
        </p>
        <Button type="button" variant="secondary" loading={exporting} onClick={handleExport}>
          Download JSON
        </Button>
      </Card>
    </div>
  );
}
