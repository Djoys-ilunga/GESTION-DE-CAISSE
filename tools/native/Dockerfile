FROM debian:trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential pkg-config perl libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev patchelf xvfb xauth dbus-x11 ca-certificates xdotool && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 agent && useradd --uid 1000 --gid 1000 --create-home agent
