# syntax=docker/dockerfile:1
# i-bot computer-use desktop template.
# Boots (via supervisord) a virtual X display with a browser and remote access:
#   Xvfb (:0) → openbox → Google Chrome (--remote-debugging-port=9222) → x11vnc → noVNC
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

# Base desktop stack. xdotool (mouse/keyboard synthesis) and scrot (screenshots)
# are load-bearing: the computer-use executor shells out to them for every action.
# NOTE: Ubuntu's `chromium-browser` apt package is a snap shim that will not run
# in a container — we install real Google Chrome from Google's apt repo below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # X server + minimal window manager
    xvfb x11-utils openbox \
    # computer-use action primitives (executor depends on these)
    xdotool scrot \
    # remote access
    x11vnc novnc websockify \
    # recording + media
    ffmpeg \
    # CJK fonts + input (feishu/lark, Chinese sites render correctly)
    fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
    # process supervisor + utils
    supervisor ca-certificates curl wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Real Google Chrome (not the snap-shim chromium-browser). Add Google's signed
# apt repo, then install the stable channel. Binary lands at
# /usr/bin/google-chrome-stable (see start-chrome.sh).
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# noVNC expects a vnc.html entry; expose the standard one as index.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html || true

COPY supervisord.conf /etc/supervisor/conf.d/desktop.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY start-chrome.sh /usr/local/bin/start-chrome.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-chrome.sh

# Run as root — load-bearing. supervisord.conf is `user=root` and entrypoint.sh
# writes /var/run + binds display/VNC ports. The template builder transpiles this
# Dockerfile instruction-by-instruction and, if no USER/WORKDIR is declared,
# DEFAULTS them to `user`/`/home/user` (a non-existent account on ubuntu:22.04) —
# which would make supervisord boot as an unprivileged user and fail. Declaring
# them explicitly keeps the boot as root. Do not remove.
USER root
WORKDIR /root

# Reference only — actual exposure to the internet is via the platform's
# getHost(port); these document the boot services' ports.
#   9222 CDP · 5900 VNC · 6080 noVNC
EXPOSE 9222 5900 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
