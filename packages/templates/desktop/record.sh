#!/usr/bin/env bash
# On-demand task screen recording. The agent runs this (via commands.run) to
# capture the desktop while performing a task, then uploads the mp4 to R2 and
# attaches it to the assistant message (source="recording").
#
# Usage:
#   record.sh start [outfile]   -> begins capture, writes PID file
#   record.sh stop              -> stops capture, prints the output path
#
# Recording is NOT a boot service (see supervisord.conf) — it runs only when a
# task wants a replay, so idle sandboxes don't burn CPU/disk on video.
set -euo pipefail

PIDFILE=/tmp/ibot-record.pid
OUT="${2:-/tmp/ibot-recording-$(date +%s).mp4}"
GEOM="${SCREEN_GEOMETRY%x*}" # strip depth, e.g. 1280x800x24 -> 1280x800

case "${1:-}" in
  start)
    if [[ -f "$PIDFILE" ]]; then echo "already recording (pid $(cat "$PIDFILE"))"; exit 0; fi
    ffmpeg -y -f x11grab -draw_mouse 1 -framerate 15 -video_size "$GEOM" -i :0 \
      -codec:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT" \
      >/var/log/ibot-record.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "$OUT" > /tmp/ibot-record.out
    echo "recording -> $OUT"
    ;;
  stop)
    if [[ ! -f "$PIDFILE" ]]; then echo "not recording"; exit 0; fi
    kill -INT "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
    rm -f "$PIDFILE"
    cat /tmp/ibot-record.out
    ;;
  *)
    echo "usage: record.sh {start [outfile]|stop}" >&2; exit 2 ;;
esac
