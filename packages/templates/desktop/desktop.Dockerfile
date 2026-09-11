# i-bot computer-use desktop template.
# Boots (via supervisord) a virtual X display with a browser and remote access:
#   Xvfb (:0) → openbox → Chromium (--remote-debugging-port=9222) → x11vnc → noVNC
# ffmpeg is preinstalled for on-demand task screen recording (x11grab → mp4).
#
# Built & registered with the PPIO/AIProxy control plane via ./build.sh.
# The base image is a plain Ubuntu; the platform injects envd (control channel
# on :49983) at build/boot — do not install or expose it here.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN_GEOMETRY=1280x800x24 \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    # X server + minimal window manager
    xvfb x11-utils openbox \
    # remote access
    x11vnc novnc websockify \
    # browser
    chromium-browser \
    # recording + media
    ffmpeg \
    # CJK fonts + input (feishu/lark, Chinese sites render correctly)
    fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
    # process supervisor + utils
    supervisor ca-certificates curl wget \
    && rm -rf /var/lib/apt/lists/*

# noVNC expects a vnc.html entry; expose the standard one as index.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html || true

COPY supervisord.conf /etc/supervisor/conf.d/desktop.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY start-chrome.sh /usr/local/bin/start-chrome.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-chrome.sh

# Reference only — actual exposure to the internet is via the platform's
# getHost(port); these document the boot services' ports.
#   9222 CDP · 5900 VNC · 6080 noVNC
EXPOSE 9222 5900 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
