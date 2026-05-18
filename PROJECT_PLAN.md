# LLM AI Router (SaaS) — MASTER PROJECT PLAN

Last reviewed: 2026-05-13

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
| 00 | [plans/00-one-shot-runbook.md](plans/00-one-shot-runbook.md) | Spike, stop gate, evidence, subagent |
| 01 | [plans/01-plan-docs-branch.md](plans/01-plan-docs-branch.md) | Nhánh, tài liệu, tính toàn vẹn plan |
| 02 | [plans/02-postgres-saas-foundation.md](plans/02-postgres-saas-foundation.md) | `SAAS_DATABASE_URL`, pool `pg`, `.env.example` |
| 03 | [plans/03-auth-users-sessions.md](plans/03-auth-users-sessions.md) | Login Postgres (read-only), JWT; **không** đổi MK |
| 04 | [plans/04-ui-login-api-keys.md](plans/04-ui-login-api-keys.md) | UI login; account read-only; export; **preset Ramclouds** (DESIGN §7) |
| 05 | [plans/05-proxy-tenant-chat.md](plans/05-proxy-tenant-chat.md) | `validateApiKey` → `tokens`; TenantContext; chat |
| 06 | [plans/06-dashboard-api-authorization.md](plans/06-dashboard-api-authorization.md) | Middleware / guard `/api` cấu hình |
| 07 | [plans/07-ci-docker-release.md](plans/07-ci-docker-release.md) | GitHub Actions build/push image |
| 08 | [plans/08-admin-overview.md](plans/08-admin-overview.md) | Sys admin: nhận diện + overview tenant (Postgres chỉ đọc) |

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

### Issue GitHub (pha đang làm)

- **P02:** [#1 — Postgres pool + SAAS_DATABASE_URL](https://github.com/ngapngap/9router/issues/1) — PR [#2](https://github.com/ngapngap/9router/pull/2)

---

## 7. Rủi ro đã ghi nhận

- **Ứng này chỉ đọc Postgres** — mọi cập nhật user/token/password do **New-API / admin**; tránh hiểu nhầm “SaaS cũng ghi DB”.
- **Latency** Tailscale → Postgres.
- **Phụ thuộc New-API** — downtime hoặc schema đổi phía hệ thống identity có thể ảnh hưởng đăng nhập/proxy; **không** có SLA từ plan này (dự án phi thương mại — xem **§0**).
- **Bảo mật**: không commit secret; JWT production; export JSON không lộ dữ liệu user khác; admin overview có **enumerate user** — hạn chế PII trong log, bắt buộc auth admin mạnh (`SAAS_ADMIN_USER_IDS` hoặc **`role IN (10,100)`** qua `SAAS_ADMIN_ROLE_VALUES`).

---

## 8. Ghi chú đồng bộ

Khi đóng một issue lớn: cập nhật bảng mục §6, thêm dòng **Evidence** (PR #, run CI id) vào file pha tương ứng trong `plans/`.
