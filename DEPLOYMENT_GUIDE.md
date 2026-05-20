# Hướng dẫn triển khai 9router SaaS — Production

> Hướng dẫn này dành cho người vận hành muốn deploy 9router SaaS lên VPS.
> Yêu cầu: Linux VPS (Ubuntu 22.04+), Docker, domain + reverse proxy (Caddy/Nginx).
> Thời gian ước tính: ~2 giờ (lần đầu).

---

## Mục lục

1. [Chuẩn bị VPS](#1-chuẩn-bị-vps)
2. [Cài đặt Docker + Docker Compose](#2-cài-đặt-docker)
3. [Clone repo + cấu hình env](#3-clone-repo--cấu-hình-env)
4. [Khởi động service](#4-khởi-động-service)
5. [Setup reverse proxy (HTTPS)](#5-setup-reverse-proxy-https)
6. [Setup backup tự động](#6-setup-backup-tự-động)
7. [Chạy restore drill (test khôi phục)](#7-chạy-restore-drill)
8. [Chạy load test](#8-chạy-load-test)
9. [Smoke test 2 user](#9-smoke-test-2-user)
10. [Verify bảo mật](#10-verify-bảo-mật)
11. [Monitoring cơ bản](#11-monitoring-cơ-bản)
12. [Checklist cuối cùng](#12-checklist-cuối-cùng)

---

## 1. Chuẩn bị VPS

### Yêu cầu tối thiểu

| Mục | Tối thiểu | Khuyến nghị |
|-----|-----------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB SSD | 50 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Network | Public IP + domain | + Tailscale (nếu Postgres ở máy khác) |

### Kiểm tra

```bash
# CPU + RAM
nproc && free -h

# Disk
df -h /

# OS
lsb_release -a
```

---

## 2. Cài đặt Docker

```bash
# Cài Docker
curl -fsSL https://get.docker.com | sh

# Thêm user hiện tại vào group docker (không cần sudo)
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

---

## 3. Clone repo + cấu hình env

### 3.1 Clone

```bash
cd /opt
git clone https://github.com/ngapngap/9router.git
cd 9router
```

### 3.2 Tạo file `.env.production`

```bash
cp .env.example .env.production
nano .env.production
```

**Các env BẮT BUỘC phải đổi:**

```bash
# ⚠️ QUAN TRỌNG — đổi ngay, không dùng default
JWT_SECRET=<random-string-64-ky-tu>          # openssl rand -base64 48
INITIAL_PASSWORD=<mat-khau-admin-dau-tien>

# SaaS mode
SAAS_ENABLED=true

# Postgres New-API (đã có sẵn ở máy khác)
SAAS_DATABASE_URL=postgresql://readonly:password@postgres-host:5432/new-api

# Port
PORT=20130
NODE_ENV=production

# Cookie secure (bật khi có HTTPS)
AUTH_COOKIE_SECURE=true
```

**Tạo JWT_SECRET an toàn:**
```bash
openssl rand -base64 48
# Copy output → paste vào JWT_SECRET=
```

### 3.3 Tạo thư mục data

```bash
sudo mkdir -p /var/lib/9router
sudo chown $USER:$USER /var/lib/9router
```

Thêm vào `.env.production`:
```bash
DATA_DIR=/var/lib/9router
```

---

## 4. Khởi động service

### Dùng Docker Compose (khuyến nghị)

```bash
# Pull image mới nhất
docker compose pull

# Start (background)
docker compose --env-file .env.production up -d

# Xem logs
docker compose logs -f --tail 50

# Verify chạy OK
curl -s http://localhost:20130/api/health | jq .
# Kỳ vọng: { "ok": true, "checks": { "pg": { "status": "ok" }, ... } }
```

### Dùng Docker trực tiếp (nếu không có compose)

```bash
docker run -d \
  --name 9router-saas \
  --env-file .env.production \
  -v /var/lib/9router:/var/lib/9router \
  -p 20130:20130 \
  --restart unless-stopped \
  ghcr.io/ngapngap/9router:latest
```

---

## 5. Setup reverse proxy (HTTPS)

### Caddy (đơn giản nhất — auto HTTPS)

```bash
# Cài Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Tạo `/etc/caddy/Caddyfile`:
```
your-domain.com {
    reverse_proxy localhost:20130
}
```

```bash
sudo systemctl restart caddy
# Caddy tự lấy cert Let's Encrypt
```

### Verify HTTPS

```bash
curl -sI https://your-domain.com/api/health | head -20
# Verify: HTTP/2 200 + security headers có mặt
```

---

## 6. Setup backup tự động

### 6.1 Cài tool mã hóa

```bash
sudo apt install age
```

### 6.2 Tạo key

```bash
sudo mkdir -p /etc/9router
age-keygen -o /etc/9router/backup-key.txt
age-keygen -y /etc/9router/backup-key.txt > /etc/9router/backup-key.pub
```

⚠️ **Copy `/etc/9router/backup-key.txt` ra nơi an toàn khác** (USB, password manager). Mất key = mất backup.

### 6.3 Tạo S3 bucket

```bash
# AWS
aws s3 mb s3://9router-backups

# Hoặc Backblaze B2
b2 create-bucket 9router-backups allPrivate
```

### 6.4 Thêm env backup

Thêm vào `.env.production`:
```bash
BACKUP_REMOTE=s3://9router-backups
BACKUP_RETENTION_DAYS=7
BACKUP_ENCRYPT_KEY_PATH=/etc/9router/backup-key.pub
```

### 6.5 Test thủ công

```bash
source .env.production
bash scripts/backup/snapshot.sh
```

Kỳ vọng: `[backup] Done: 9router-saas-YYYY-MM-DD_HHMMSS.tar.gz.age`

### 6.6 Setup cron (2h sáng mỗi ngày)

```bash
cat << 'EOF' | sudo tee /etc/cron.d/9router-backup
SHELL=/bin/bash
0 2 * * * root cd /opt/9router && source .env.production && bash scripts/backup/snapshot.sh >> /var/log/9router-backup.log 2>&1
EOF
```

### 6.7 Verify cron

```bash
# Chờ đến 2h sáng, hoặc test ngay:
sudo run-parts --test /etc/cron.d/
# Check log ngày hôm sau:
tail -20 /var/log/9router-backup.log
```

---

## 7. Chạy restore drill

Mục đích: verify backup có thể khôi phục được.

```bash
# 1. Chọn user test
USER_ID=42

# 2. Download backup mới nhất
aws s3 ls s3://9router-backups/ | tail -1
aws s3 cp s3://9router-backups/9router-saas-YYYY-MM-DD_HHMMSS.tar.gz.age /tmp/

# 3. Decrypt
age -d -i /etc/9router/backup-key.txt /tmp/9router-saas-*.age > /tmp/backup.tar.gz

# 4. Extract 1 user
mkdir /tmp/restore-test
tar -xzf /tmp/backup.tar.gz -C /tmp/restore-test saas/users/$USER_ID/

# 5. Verify SQLite
sqlite3 /tmp/restore-test/saas/users/$USER_ID/data.sqlite "PRAGMA integrity_check;"
# Kỳ vọng: "ok"

sqlite3 /tmp/restore-test/saas/users/$USER_ID/data.sqlite "SELECT count(*) FROM providers;"
# Kỳ vọng: số > 0

# 6. Cleanup
rm -rf /tmp/restore-test /tmp/backup.tar.gz /tmp/9router-saas-*.age
```

Pass nếu: `integrity_check` = "ok" + có data.

---

## 8. Chạy load test

### 8.1 Cài k6

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### 8.2 Chạy

```bash
k6 run \
  --env BASE_URL=https://your-domain.com \
  --env API_KEY=sk-your-test-key \
  --env LOGIN_USER=testuser \
  --env LOGIN_PASS=testpass \
  scripts/loadtest/k6-saas-50users.js
```

### 8.3 Đọc kết quả

```
=== 9router SaaS Load Test Summary ===
Total requests: 1523
p95 latency: 847ms (threshold: <2000ms)
Error rate: 0.13% (threshold: <1%)
Result: ✅ PASS
=====================================
```

### 8.4 Monitor server song song

```bash
# Terminal khác:
docker stats 9router-saas
# Hoặc:
htop
```

Pass nếu: **p95 < 2000ms** + **error < 1%** + **CPU < 50%**

---

## 9. Smoke test 2 user

### 9.1 Browser test

1. Mở `https://your-domain.com/login` → login user A → verify dashboard
2. Mở incognito → login user B → verify dashboard
3. **Quan trọng**: User B KHÔNG thấy providers/keys của user A

### 9.2 API test

```bash
# User A
curl -s https://your-domain.com/api/v1/models \
  -H "Authorization: Bearer sk-userA-key" | jq '.data | length'

# User B
curl -s https://your-domain.com/api/v1/models \
  -H "Authorization: Bearer sk-userB-key" | jq '.data | length'
```

Pass nếu: 2 user thấy data riêng, không lẫn.

---

## 10. Verify bảo mật

### 10.1 Security headers

```bash
curl -sI https://your-domain.com/dashboard | grep -iE "content-security|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy"
```

Kỳ vọng: 6 header có mặt.

### 10.2 JWT_SECRET không dùng default

```bash
# Trên server:
grep JWT_SECRET .env.production
# KHÔNG được là "change-me-to-a-long-random-secret" hay "9router-default-secret-change-me"
```

### 10.3 Rate limit hoạt động

```bash
# Spam login 10 lần liên tiếp
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://your-domain.com/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"fake","password":"fake"}'
done
# Kỳ vọng: 5 lần đầu 401, sau đó 429 (rate limited)
```

### 10.4 CSRF protection

```bash
# POST không có CSRF token → 403
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://your-domain.com/api/settings \
  -H "Content-Type: application/json" \
  -H "Cookie: auth_token=valid-jwt-here" \
  -d '{}'
# Kỳ vọng: 403
```

### 10.5 Health check

```bash
curl -s https://your-domain.com/api/health | jq .
# Kỳ vọng: { "ok": true, "checks": { "pg": {"status":"ok"}, "dataDir": {"status":"ok"}, "disk": {"status":"ok"} } }
```

---

## 11. Monitoring cơ bản

### 11.1 Uptime monitor (miễn phí)

Đăng ký [UptimeRobot](https://uptimerobot.com) hoặc [Healthchecks.io](https://healthchecks.io):
- Monitor URL: `https://your-domain.com/api/health/live`
- Interval: 60s
- Alert: email/Telegram khi down

### 11.2 Disk alert (cron)

```bash
cat << 'EOF' | sudo tee /etc/cron.d/9router-disk-alert
# Alert nếu disk < 10%
0 */6 * * * root df / | awk 'NR==2{if(int($5)>90) system("echo DISK FULL | mail -s 9router-alert admin@email.com")}'
EOF
```

### 11.3 Log audit hàng ngày

```bash
# Xem audit log hôm nay
cat /var/lib/9router/saas/audit/admin-$(date +%F).log | jq .

# Hoặc dùng CLI script
node --env-file=.env.production scripts/admin/audit-query.mjs --since $(date +%F)
```

---

## 12. Checklist cuối cùng

Tick từng mục trước khi mở public:

```
[ ] Docker service chạy ổn định > 24h không restart
[ ] HTTPS hoạt động (cert valid)
[ ] JWT_SECRET đã set (không dùng default)
[ ] Backup chạy tự động (verify log)
[ ] Restore drill pass (SQLite integrity OK)
[ ] Load test pass (p95 <2s, error <1%, CPU <50%)
[ ] Smoke test 2 user (không lẫn data)
[ ] Security headers có mặt (6/6)
[ ] Rate limit hoạt động (429 sau 5 req)
[ ] Health check trả 200 (3 checks OK)
[ ] Uptime monitor active
[ ] Backup key lưu ở 2 nơi tách biệt
[ ] .env.production KHÔNG commit lên git
```

Khi tất cả đã pass → **Mở public beta**

---

## Troubleshooting

| Vấn đề | Nguyên nhân | Fix |
|--------|-------------|-----|
| `502 Bad Gateway` | Service chưa start / port sai | `docker logs 9router-saas`, check PORT env |
| `503 Service Unavailable` | Health check fail | `curl localhost:20130/api/health` xem check nào fail |
| Login luôn 401 | JWT_SECRET sai / Postgres không kết nối được | Check `SAAS_DATABASE_URL`, `docker exec ... ping postgres-host` |
| Dashboard trắng | Build lỗi / CSP block | Check browser console, verify CSP header |
| Backup fail | Key path sai / S3 credentials | Check env `BACKUP_*`, test `aws s3 ls` |
| Rate limit quá strict | Default 5 req/60s | Tăng `MAX_REQUESTS` trong `rateLimit.js` hoặc thêm env override |

---

## Liên hệ

- Repo: https://github.com/ngapngap/9router
- Issues: https://github.com/ngapngap/9router/issues
- Plan chi tiết: `plans/` (local-only, gitignored)
