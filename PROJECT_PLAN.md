# LLM AI Router (SaaS) — MASTER PROJECT PLAN

Last reviewed: 2026-05-20 — Baseline P00–P08 đã hoàn thành; SaaS Hardening P09–P11 + Security baseline P12 đang triển khai.

File này là **nguồn sự thật** cho triển khai fork **ngapngap/9router** hướng SaaS: **chỉ đọc** PostgreSQL New-API (DB `new-api`); giao diện **llmairouter.com**; **không** đăng ký; **không** đổi mật khẩu trong app (khác 9router gốc); user **cô lập** hoàn toàn (chỉ config/metadata của mình); export kiểu db.json **theo user**; **sys admin** xem tổng quan tenant (pha 08, DESIGN **§6**); preset **Ramclouds** trên Providers (DESIGN **§7**).

Các pha thực thi chi tiết nằm trong `plans/` — làm **theo thứ tự số**. [AGENT.md](AGENT.md) là quy tắc agent (issue, CI, spike). Plan Cursor (`.cursor/plans/saas_cho_9router*.md`) là bản thảo; khi mâu thuẫn, ưu tiên **file trong repo này**.

---

## 0. Bản chất dự án — cộng đồng, phi thương mại (hỗ trợ New-API)

### 0.1 Định vị

- **Miễn phí**, phục vụ người dùng **New-API** (định danh đọc từ Postgres `new-api`): dashboard router + proxy OpenAI-compatible; **không** bán subscription qua app này.
- **Không** cam kết SLA, DPA, billing hay compliance kiểu doanh nghiệp — kế hoạch triển khai **00–08** đủ cho mục tiêu kỹ thuật đã mô tả.
- Hạ tầng (Tailscale, máy chủ, backup disk) do **người vận hành** tự quyết; tài liệu gợi ý kết nối DB là **ví dụ**, không phải cam kết hosting.

### 0.2 Cố ý ngoài scope (không bắt buộc agent / PR theo plan gốc)

- Hợp đồng pháp lý B2B, subprocessors, định giá, status page kiểu sản phẩm trả phí.
- «Production SaaS enterprise»: backup đa region, WAF mua ngoài, pentest định kỳ — chỉ khi team mở **issue / pha mở rộng** riêng.

### 0.3 Vẫn ưu tiên (uy tín + an toàn tối thiểu)

- **Cô lập tenant** — `getAdapterForUser`, guard `/api` (pha 06); không đọc/ghi SQLite user khác.
- **Bảo vệ đăng nhập & proxy** — rate limit login (DESIGN §13), JWT an toàn; không log mật khẩu hay Bearer đầy đủ; phân biệt lỗi **401** (credential) vs **502/503** (upstream / New-API).
- **Phụ thuộc New-API:** sự cố identity/DB phía hạ tầng New-API có thể làm app lỗi theo — thông báo lỗi rõ cho người dùng, không đổ lỗi mơ hồ.
- **Cấu hình cục bộ** lưu tại `DATA_DIR/saas/users/<id>/data.sqlite` — **mất volume = mất cấu hình router**; operator nên **sao lưu thư mục `DATA_DIR`** (chi tiết [DESIGN §5.6](plans/DESIGN-pages-and-apis.md), [APPENDIX vận hành](plans/APPENDIX-ops-testing-performance.md)).

### 0.4 Ghi chú cho agent / review

- Không dùng checklist «SaaS thương mại đầy đủ» để chặn merge; nguồn sự thật là **pha 00–08** + [DESIGN](plans/DESIGN-pages-and-apis.md) + [APPENDIX](plans/APPENDIX-postgres-new-api-schema.md).
- **Mạng riêng** (ví dụ Tailscale tới Postgres) là **chấp nhận được** cho triển khai tình nguyện; yêu cầu TLS/VPC kiểu cloud chỉ khi bạn **công khai dịch vụ rộng** và chủ động hardening thêm (ngoài phạm vi bắt buộc của plan này).

---

## 1. Thứ tự thực thi (phase files)

| Order | File | Mục đích |
|-------|------|----------|
| REF | [plans/APPENDIX-ops-testing-performance.md](plans/APPENDIX-ops-testing-performance.md) | Backup SQLite, smoke/tenant test tối thiểu, pool/SQLite perf (free tool) |
| REF | [plans/DESIGN-pages-and-apis.md](plans/DESIGN-pages-and-apis.md) | §8–§13 hợp đồng API + wireframe UI; §5 SQLite; §5.2.1 onboarding; §6–§7 admin/Ramclouds |
| REF | [plans/APPENDIX-postgres-new-api-schema.md](plans/APPENDIX-postgres-new-api-schema.md) | Cột thực tế `users`/`tokens`, bcrypt, role 10/100 |
| REF | [plans/APPENDIX-saas-hardening.md](plans/APPENDIX-saas-hardening.md) | Audit isolation/global-state, env mới, runbook backup/health, rủi ro P09–P11 |
| 00 | [plans/00-one-shot-runbook.md](plans/00-one-shot-runbook.md) | Spike, stop gate, evidence, subagent |
| 01 | [plans/01-plan-docs-branch.md](plans/01-plan-docs-branch.md) | Nhánh, tài liệu, tính toàn vẹn plan |
| 02 | [plans/02-postgres-saas-foundation.md](plans/02-postgres-saas-foundation.md) | `SAAS_DATABASE_URL`, pool `pg`, `.env.example` |
| 03 | [plans/03-auth-users-sessions.md](plans/03-auth-users-sessions.md) | Login Postgres (read-only), JWT; **không** đổi MK |
| 04 | [plans/04-ui-login-api-keys.md](plans/04-ui-login-api-keys.md) | UI login; account read-only; export; **preset Ramclouds** (DESIGN §7) |
| 05 | [plans/05-proxy-tenant-chat.md](plans/05-proxy-tenant-chat.md) | `validateApiKey` → `tokens`; TenantContext; chat |
| 06 | [plans/06-dashboard-api-authorization.md](plans/06-dashboard-api-authorization.md) | Middleware / guard `/api` cấu hình |
| 07 | [plans/07-ci-docker-release.md](plans/07-ci-docker-release.md) | GitHub Actions build/push image |
| 08 | [plans/08-admin-overview.md](plans/08-admin-overview.md) | Sys admin: nhận diện + overview tenant (Postgres chỉ đọc) |
| 09 | [plans/09-multi-tenant-isolation.md](plans/09-multi-tenant-isolation.md) | Hardening cô lập tenant: driver fallback, `usageRepo`, `consoleLogBuffer`, `rateLimit`, `open-sse` caches |
| 10 | [plans/10-ops-backup-health.md](plans/10-ops-backup-health.md) | Backup `DATA_DIR` + restore drill, `/api/health` deep check, audit log mở rộng, runbook on-call |
| 11 | [plans/11-admin-operability.md](plans/11-admin-operability.md) | CLI admin scripts, feature flag env-only, quota guard pre-flight + streaming overrun |
| 12 | [plans/12-security-audit.md](plans/12-security-audit.md) | Security baseline: CI/supply chain hardening, web headers, rate limit Bearer, CSRF, JWT claims, error message wrap |

---

## 2. Mục tiêu nghiệp vụ và kỹ thuật

**Nghiệp vụ**

- Người dùng chỉ tồn tại khi đã có trong `public.users` (tạo bởi New-API / admin).
- Họ đăng nhập vào dashboard 9router, cấu hình provider như self-host, dùng API key trong `public.tokens` để gọi endpoint OpenAI-compatible.

**Kỹ thuật**

| Thành phần | Quyết định |
|------------|------------|
| DB SaaS | `postgresql://<u>:<p>@100.110.169.71:5432/new-api?sslmode=disable` (máy app trong Tailscale) |
| Self-host (`SAAS_ENABLED` tắt) | Một SQLite như upstream: [schema.js](src/lib/db/schema.js), `DATA_DIR/db/data.sqlite` |
| Dashboard / export (SaaS) | SQLite **per `users.id`** dưới `DATA_DIR/saas/users/` — chi tiết [DESIGN §4–§5](plans/DESIGN-pages-and-apis.md) |
| User / token | `public.users`, `public.tokens` — chi tiết cột [APPENDIX](plans/APPENDIX-postgres-new-api-schema.md); pool ở `plans/02` |
| Đăng ký | **Không** triển khai `/register` |

**SaaS Hardening (P09–P11)** — sau khi baseline P00–P08 đóng, tập trung chặn leak đa tenant ở `usageRepo`, `consoleLogBuffer`, `rateLimit`, `open-sse` caches; bổ sung backup `DATA_DIR` + restore drill, health check sâu, audit log mở rộng; cung cấp CLI admin và quota guard pre-flight. Chi tiết [APPENDIX-saas-hardening.md](plans/APPENDIX-saas-hardening.md).

**Security baseline (P12)** — sau P11, đóng các lỗ hổng code/CI/web không thuộc multi-tenancy: JWT_SECRET fallback hardcode, security headers (CSP/HSTS/XFO...), Trivy CI fail-on-CRITICAL, pin actions SHA, lock file tracked, rate limit `/api/v1/*` Bearer per-key, CSRF double-submit, JWT `aud`/`iss` claims, error.message wrap. Chi tiết [12-security-audit.md](plans/12-security-audit.md).

---

## 3. Tiêu chuẩn chất lượng plan

Một plan được coi là **đủ** khi:

1. Mục tiêu nghiệp vụ và phạm vi kỹ thuật rõ.
2. Công việc phụ thuộc từ plan → Postgres → auth → UI → proxy → CI.
3. Mọi pha có **tiêu chí nghiệm thu** và **evidence** (PR, CI) — comment issue dùng mẫu JSON tại [00-one-shot-runbook.md#evidence-json](plans/00-one-shot-runbook.md#evidence-json).
4. Gắn **GitHub issue** cho từng cụm; không merge khi CI đỏ.
5. Ghi **blocker** và issue follow-up thay vì nói chung chung “xong”.
6. Cập nhật plan sau mỗi lần thay đổi scope.

**Spike** và **luồng khi fail**: [00-one-shot-runbook.md](plans/00-one-shot-runbook.md) (kể cả mục «Luồng xử lý khi fail»).

---

## 4. Ký hiệu trạng thái

- `[x]` hoàn thành đúng phạm vi dòng đó.
- `[ ]` chưa xong.
- **Baseline done**: có stub / biến env / kết nối thử được.
- **Production pending**: cần hardening, CI image, hoặc review bảo mật.

---

## 5. Nguồn sự thật hiện tại

| Mục | Giá trị |
|-----|---------|
| GitHub | `https://github.com/ngapngap/9router` |
| Postgres host (Tailscale) | `100.110.169.71:5432` → Docker `postgres` → DB `new-api` |
| Schema DB | Spike 2026-05-13 — [APPENDIX-postgres-new-api-schema.md](plans/APPENDIX-postgres-new-api-schema.md) (repo là nguồn sự thật; plan Cursor nếu lệch thì bỏ qua) |
| Ops / test / perf (free) | [APPENDIX-ops-testing-performance.md](plans/APPENDIX-ops-testing-performance.md) — backup, tenant test, pool SQLite |

---

## 6. Checklist tổng (cập nhật khi làm)

| ID | Hạng mục | Trạng thái |
|----|----------|------------|
| P00 | Runbook + spike đã áp dụng cho mọi pha | [x] |
| P01 | Nhánh feature, PROJECT_PLAN/plans tracked | [x] |
| P02 | `SAAS_DATABASE_URL`, pool, healthcheck kết nối DB | [x] |
| P03 | Login + JWT; không đổi MK; không ghi Postgres | [x] |
| P03.1 | Rate limiting `/api/auth/login` 5 req/min/IP (`src/lib/rateLimit.js`) | [x] |
| P04 | UI login; account chỉ đọc; export user-scope; **Ramclouds** preset (§7) | [x] |
| P04.1 | Import endpoint `POST /api/account/import` + payload limit 5 MB | [x] |
| P05 | Chat/proxy resolve user từ `tokens.key` | [x] |
| P05.1 | bpchar padding: TRIM(key::text) cả `findTokenByKeyForProxy` lẫn `listTokensByUserId` | [x] |
| P06 | Bảo vệ API dashboard multi-tenant | [x] |
| P06.1 | Tenant isolation test (assertSafeUserId, cross-tenant, rate limiter) | [x] |
| P07 | Workflow GH build Docker image | [x] |
| P07.1 | CI build-saas + unit tests SAAS_ENABLED=true | [x] |
| P07.2 | Trivy security scan (fs mode, CRITICAL+HIGH, continue-on-error) | [x] |
| P08 | Admin: nhận diện + overview tenant; không export nội dung user khác mặc định | [x] |
| P08.1 | `SAAS_ADMIN_ROLE_VALUES` + `SAAS_ADMIN_FALLBACK_USER_ID` (numeric validation) | [x] |
| P08.2 | Admin UI: KPI 3 thẻ, toolbar, cột role/status/mtime, `totalUsersInDb` | [x] |
| P08.3 | Audit log module `src/lib/saas/auditLog.js` + tích hợp admin overview | [x] |
| P09 | Multi-tenant isolation hardening (driver fallback, `usageRepo`, `consoleLogBuffer`, `rateLimit`, `open-sse` caches) | [x] |
| P09.1 | `runAsSystem` whitelist + hostile-tenant integration test | [x] |
| P09.2 | Audit script `scripts/audit/global-state.mjs` báo 0 global cache | [x] |
| P10 | Backup + health check + audit log mở rộng + runbook on-call | [x] |
| P10.1 | Backup script + restore drill quarterly + retention 7d/4w/3m + encrypt | [x] |
| P10.2 | Health check `/api/health` deep (Postgres + DATA_DIR + disk) trả 503 khi fail | [x] |
| P10.3 | Audit log thêm 6 event (settings.save, connection.add/remove, apiKey.rotate, quota.exhausted/overrun, login.failed) | [x] |
| P11 | Admin operability: CLI scripts + feature flag env-only + quota guard edge | [x] |
| P11.1 | 5 CLI scripts (disable/enable user, audit-query, usage-report, reset-password) + dry-run + audit | [x] |
| P11.2 | Quota guard pre-flight 402 trước upstream + streaming overrun audit | [x] |
| P11.3 | `.env.example` cập nhật đủ 6 nhóm env (Identity/Admin/Console-audit/Backup/Quota/Cache strict) | [x] |
| P12 | Security baseline (CI/web/JWT/CSRF) | [x] |
| P12.1 | HIGH-1: JWT_SECRET throw nếu missing trong production (bỏ fallback hardcode) | [x] |
| P12.2 | HIGH-2: Trivy CI fail-on-CRITICAL + HIGH-3: pin third-party actions SHA | [x] |
| P12.3 | HIGH-4: package-lock.json tracked + CI dùng `npm ci` | [x] |
| P12.4 | HIGH-5: 6 security header trong `next.config.mjs` (CSP, HSTS, XFO, XCTO, Referrer, Permissions) | [x] |
| P12.5 | HIGH-6: rate limit `/api/v1/*` Bearer per `apiKeyId` | [x] |
| P12.6 | HIGH-7: redactSecrets helper + lint rule cho `console.error` upstream | [x] |
| P12.7 | MED: CSRF double-submit + JWT aud/iss + error.message wrap (24 routes) + admin/login RL + npm audit CI | [x] |

### Issue GitHub (pha đang làm)

- **P02:** [#1 — Postgres pool + SAAS_DATABASE_URL](https://github.com/ngapngap/9router/issues/1) — PR [#2](https://github.com/ngapngap/9router/pull/2)
- **P09:** [#21 — Multi-tenant isolation hardening](https://github.com/ngapngap/9router/issues/21)
- **P10:** [#23 — Ops, backup, health, audit](https://github.com/ngapngap/9router/issues/23)
- **P11:** [#22 — Admin operability — CLI scripts, quota guard](https://github.com/ngapngap/9router/issues/22)
- **P12:** [#24 — Security baseline — CI/web/JWT/CSRF](https://github.com/ngapngap/9router/issues/24)

---

## 7. Rủi ro đã ghi nhận

- **Ứng này chỉ đọc Postgres** — mọi cập nhật user/token/password do **New-API / admin**; tránh hiểu nhầm “SaaS cũng ghi DB”.
- **Latency** Tailscale → Postgres.
- **Phụ thuộc New-API** — downtime hoặc schema đổi phía hệ thống identity có thể ảnh hưởng đăng nhập/proxy; **không** có SLA từ plan này (dự án phi thương mại — xem **§0**).
- **Bảo mật**: không commit secret; JWT production; export JSON không lộ dữ liệu user khác; admin overview có **enumerate user** — hạn chế PII trong log, bắt buộc auth admin mạnh (`SAAS_ADMIN_USER_IDS` hoặc **`role IN (10,100)`** qua `SAAS_ADMIN_ROLE_VALUES`).
- **P09 — `runAsSystem` whitelist**: throw on missing tenant context có thể phá vỡ startup hooks/jobs nền — mitigate bằng whitelist allow-list các call-site hệ thống, log cảnh báo nếu chạm whitelist ngoài dự kiến.
- **P09 — inode pressure SQLite per-user**: số file SQLite >50k user → áp lực inode trên ext4/xfs; ngưỡng cảnh báo + plan migrate Option C (gộp shard / Postgres tenant table) nêu trong [APPENDIX-saas-hardening §4](plans/APPENDIX-saas-hardening.md).
- **P09 — token cache module-level (`src/lib/open-sse/`)**: nhiều caller đã phụ thuộc cache toàn cục; refactor sang per-tenant gắn sau env flag `SAAS_TENANT_CACHE_STRICT` để rollout dần, tránh regress streaming.
- **P12 — JWT_SECRET fallback hardcode**: `dashboardSession.js:3-5` có fallback `"9router-default-secret-change-me"` không throw — ai đọc repo public đều forge admin token. P12 throw nếu `NODE_ENV==="production"` && env missing; phải verify trước public release.
- **P12 — Trivy không fail CI**: `ci.yml:61-85` `exit-code: "0"` + `continue-on-error: true` → CRITICAL CVE bị nuốt. P12 đổi `exit-code: 1` cho CRITICAL; trước fix, mọi CVE chỉ là cảnh báo nhẹ.
- **P12 — Actions không pin SHA**: `trivy-action@master` (mutable) + các action @v4 tag float — supply chain attack từ third-party có thể inject malicious step. P12 pin SHA full 40 ký tự; cần Dependabot weekly update.

---

## 8. Ghi chú đồng bộ

Khi đóng một issue lớn: cập nhật bảng mục §6, thêm dòng **Evidence** (PR #, run CI id) vào file pha tương ứng trong `plans/`.
