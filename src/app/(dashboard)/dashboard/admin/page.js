"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "@/shared/components";

function formatBytes(n) {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const PAGE_SIZES = [25, 50, 100];
const STATUS_MAP = { 1: "Enabled", 2: "Disabled" };

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [stats, setStats] = useState({ totalUsersListed: 0, withStore: 0, totalStoreBytes: 0 });
  const [searchQ, setSearchQ] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [inputQ, setInputQ] = useState("");

  const load = useCallback(async (afterId = 0, append = false, q = "", limit = 50) => {
    setErr("");
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit) });
    if (afterId) params.set("afterId", String(afterId));
    if (q) params.set("q", q);
    const res = await fetch(`/api/admin/overview?${params}`);
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
    setStats(data.stats || { totalUsersListed: 0, withStore: 0, totalStoreBytes: 0 });
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load(0, false, searchQ, pageSize);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSearch = () => {
    setSearchQ(inputQ);
    setRows([]);
    load(0, false, inputQ, pageSize);
  };

  const handleRefresh = () => {
    setRows([]);
    load(0, false, searchQ, pageSize);
  };

  const handlePageSizeChange = (newSize) => {
    setPageSize(newSize);
    setRows([]);
    load(0, false, searchQ, newSize);
  };

  if (loading && rows.length === 0) {
    return <div className="text-sm text-zinc-500 p-6">Đang tải…</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Tổng quan tenant</h1>
        <p className="text-sm text-zinc-500 mt-1">Chỉ đọc Postgres + trạng thái store cục bộ — không sửa user/token tại đây.</p>
      </div>

      {err ? <div className="text-sm text-amber-400">{err}</div> : null}

      {/* KPI 3 thẻ — DESIGN §12.2 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="p-4">
            <div className="text-sm text-zinc-500">Người dùng (Postgres)</div>
            <div className="text-2xl font-bold text-zinc-100 mt-1">{stats.totalUsersListed}</div>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <div className="text-sm text-zinc-500">Đã có cấu hình router</div>
            <div className="text-2xl font-bold text-zinc-100 mt-1">{stats.withStore}</div>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <div className="text-sm text-zinc-500">Tổng dung lượng store</div>
            <div className="text-2xl font-bold text-zinc-100 mt-1">{formatBytes(stats.totalStoreBytes)}</div>
          </div>
        </Card>
      </div>

      {/* Toolbar — DESIGN §12.2 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <input
            type="text"
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 w-full max-w-xs"
            placeholder="Email hoặc ID"
            value={inputQ}
            onChange={(e) => setInputQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button type="button" className="text-sm text-sky-400 hover:underline whitespace-nowrap" onClick={handleSearch}>
            Tìm
          </button>
        </div>
        <button type="button" className="text-sm text-sky-400 hover:underline" onClick={handleRefresh}>
          Làm mới
        </button>
        <select
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
          value={pageSize}
          onChange={(e) => handlePageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>{s}/trang</option>
          ))}
        </select>
      </div>

      {/* Bảng chính — DESIGN §12.2 */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left text-zinc-300">
            <thead className="text-zinc-500 border-b border-zinc-700">
              <tr>
                <th className="py-2 pr-4">ID</th>
                <th className="py-2 pr-4">Định danh</th>
                <th className="py-2 pr-4">Trạng thái</th>
                <th className="py-2 pr-4">Store</th>
                <th className="py-2 pr-4">Dung lượng</th>
                <th className="py-2">Cập nhật store</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-4 font-mono">{u.id}</td>
                  <td className="py-2 pr-4">{u.email || u.username || "—"}</td>
                  <td className="py-2 pr-4">
                    {u.status != null ? (
                      <span className={u.status === 1 ? "text-emerald-400" : "text-red-400"}>
                        {STATUS_MAP[u.status] || u.status}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-2 pr-4">{u.hasLocalRouterStore ? "✓ Có" : "✗ Chưa"}</td>
                  <td className="py-2 pr-4">{formatBytes(u.storeBytes)}</td>
                  <td className="py-2">{u.storeMtime ? new Date(u.storeMtime).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && !loading ? (
          <div className="text-sm text-zinc-500 py-4 text-center">Chưa có dữ liệu</div>
        ) : null}

        {hasMore && nextCursor != null ? (
          <div className="pt-4">
            <button
              type="button"
              className="text-sm text-sky-400 hover:underline"
              onClick={() => load(nextCursor, true, searchQ, pageSize)}
            >
              Tải thêm
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
