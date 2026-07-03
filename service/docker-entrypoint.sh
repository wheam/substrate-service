#!/bin/sh
# 从环境变量落 SSH deploy key（只读），host key 用 GitHub 官方公布值钉死（非 TOFU）。
set -e
if [ -n "$GIT_SSH_KEY_B64" ]; then
  mkdir -p /root/.ssh
  echo "$GIT_SSH_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
  chmod 600 /root/.ssh/id_ed25519
  cat > /root/.ssh/known_hosts <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
EOF
fi
exec node src/server.js
