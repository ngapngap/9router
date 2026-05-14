"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);

  const load = async (afterId = 0, append = false) => {
    setErr("");
    const q = new URLSearchParams({ limit: "50" });
    if (afterId) q.set("afterId", String(afterId));
    const res = await fetch(`/api/admin/overview?${q}`);
    if (res.status === 404) {
      setErr("Trang admin chỉ dùng khi bật SaaS.");
      setLoading(false);
      return;
    }
    if (res.status === 401) {
      setErr("Đăng nhập để xem.");
      setLoading(false);
      return;
    }
    if (res.status === 403) {
      setErr("Bạn không có quyền admin.");
      setLoading(false);
      return;
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || `Lỗi ${res.status}`);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setRows((prev) => (append ? [...prev, ...(data.users || [])] : data.users || []));
    setHasMore(!!data.hasMore);
    setNextCursor(data.nextCursor ?? null);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load(0, false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && rows.length === 0) {
    return (
      <div className="text-sm text-zinc-500 p-6">Đang tải…</div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Admin — tổng quan</h1>
        <p className="text-sm text-zinc-500 mt-1">Người dùng SaaS và dung lượng SQLite mỗi tenant.</p>
      </div>

      {err ? (
        <div className="text-sm text-amber-400">{err}</div>
      ) : null}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left text-zinc-300">
            <thead className="text-zinc-500 border-b border-zinc-700">
              <tr>
                <th className="py-2 pr-4">ID</th>
                <th className="py-2 pr-4">User</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Store</th>
                <th className="py-2">Requests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-4 font-mono">{u.id}</td>
                  <td className="py-2 pr-4">{u.username || "—"}</td>
                  <td className="py-2 pr-4">{u.email || "—"}</td>
                  <td className="py-2 pr-4">{u.role}</td>
                  <td className="py-2 pr-4">{formatBytes(u.storeBytes ?? 0)}</td>
                  <td className="py-2">{u.request_count ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {hasMore && nextCursor != null ? (
          <div className="pt-4">
            <button
              type="button"
              className="text-sm text-sky-400 hover:underline"
              onClick={() => load(nextCursor, true)}
            >
              Tải thêm
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
