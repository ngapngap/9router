# Load Test — 9router SaaS

## Prerequisites

Install k6: https://k6.io/docs/get-started/installation/

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Windows
choco install k6
```

## Usage

```bash
# Against local dev
k6 run --env BASE_URL=http://localhost:20130 --env API_KEY=sk-your-key scripts/loadtest/k6-saas-50users.js

# Against staging
k6 run --env BASE_URL=https://staging.ramclouds.me --env API_KEY=sk-staging-key scripts/loadtest/k6-saas-50users.js
```

## Acceptance criteria (P10)

- p95 latency < 2000ms
- Error rate < 1%
- CPU < 50% (monitor separately via `htop` / `docker stats`)

## Scenarios

- 10% health check
- 10% liveness probe
- 20% login (expect 429 rate limit)
- 30% chat completions (Bearer)
- 30% dashboard API (cookie auth)

## Output

k6 prints summary with PASS/FAIL verdict. Full JSON output to stdout.
