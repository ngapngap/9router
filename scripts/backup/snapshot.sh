#!/usr/bin/env bash
# scripts/backup/snapshot.sh — Backup DATA_DIR/saas (encrypt + remote upload).
#
# P10 (#23): daily backup script cho SaaS user data.
# Usage: ./scripts/backup/snapshot.sh
# Env required: DATA_DIR, BACKUP_REMOTE, BACKUP_ENCRYPT_KEY_PATH
# Optional: BACKUP_RETENTION_DAYS (default 7)
#
# Refs: https://github.com/ngapngap/9router/issues/23

set -euo pipefail

: "${DATA_DIR:?DATA_DIR env required}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE env required (s3://bucket/path or rsync://host/path)}"
: "${BACKUP_ENCRYPT_KEY_PATH:?BACKUP_ENCRYPT_KEY_PATH env required (path to age/gpg public key)}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_NAME="9router-saas-${TIMESTAMP}.tar.gz"
ENCRYPTED_NAME="${BACKUP_NAME}.age"
TMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "[backup] Starting backup: ${TIMESTAMP}"
echo "[backup] Source: ${DATA_DIR}/saas"
echo "[backup] Remote: ${BACKUP_REMOTE}"

# 1. Tar + gzip
echo "[backup] Creating archive..."
tar -czf "${TMP_DIR}/${BACKUP_NAME}" -C "${DATA_DIR}" saas

# 2. Encrypt (age preferred, fallback gpg)
echo "[backup] Encrypting..."
if command -v age &>/dev/null; then
  age -R "${BACKUP_ENCRYPT_KEY_PATH}" -o "${TMP_DIR}/${ENCRYPTED_NAME}" "${TMP_DIR}/${BACKUP_NAME}"
elif command -v gpg &>/dev/null; then
  gpg --batch --yes --recipient-file "${BACKUP_ENCRYPT_KEY_PATH}" \
    --output "${TMP_DIR}/${ENCRYPTED_NAME}" --encrypt "${TMP_DIR}/${BACKUP_NAME}"
else
  echo "[backup] ERROR: neither age nor gpg found" >&2
  exit 1
fi

# 3. Upload to remote
echo "[backup] Uploading to ${BACKUP_REMOTE}..."
if [[ "${BACKUP_REMOTE}" == s3://* ]]; then
  aws s3 cp "${TMP_DIR}/${ENCRYPTED_NAME}" "${BACKUP_REMOTE}/${ENCRYPTED_NAME}"
elif [[ "${BACKUP_REMOTE}" == b2://* ]]; then
  b2 upload-file "${BACKUP_REMOTE#b2://}" "${TMP_DIR}/${ENCRYPTED_NAME}" "${ENCRYPTED_NAME}"
else
  # Default: rsync
  rsync -avz "${TMP_DIR}/${ENCRYPTED_NAME}" "${BACKUP_REMOTE}/${ENCRYPTED_NAME}"
fi

# 4. Retention cleanup (remote — only for s3)
if [[ "${BACKUP_REMOTE}" == s3://* ]]; then
  echo "[backup] Cleaning old backups (retention: ${RETENTION_DAYS} days)..."
  CUTOFF=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y-%m-%d)
  aws s3 ls "${BACKUP_REMOTE}/" | while read -r line; do
    FILE_DATE=$(echo "$line" | awk '{print $1}')
    FILE_NAME=$(echo "$line" | awk '{print $4}')
    if [[ "${FILE_DATE}" < "${CUTOFF}" && "${FILE_NAME}" == 9router-saas-* ]]; then
      aws s3 rm "${BACKUP_REMOTE}/${FILE_NAME}"
      echo "[backup] Removed old: ${FILE_NAME}"
    fi
  done
fi

echo "[backup] Done: ${ENCRYPTED_NAME}"
