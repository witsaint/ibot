#!/usr/bin/env bash
# Desktop template entrypoint: prepare runtime dirs, then hand off to supervisord
# which brings up Xvfb → openbox → Chrome → x11vnc → noVNC (see supervisord.conf).
set -euo pipefail

mkdir -p /var/log/supervisor /var/run
# Chrome profile dir (kept on the sandbox overlay disk).
mkdir -p /root/chrome-profile

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/desktop.conf
