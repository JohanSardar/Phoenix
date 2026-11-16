FROM node:24-bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git patch ripgrep unzip && rm -rf /var/lib/apt/lists/*
RUN arch=$(case "$TARGETARCH" in amd64) echo x64;; *) echo arm64;; esac) && \
    npm install -g --ignore-scripts opencode-linux-$arch@1.19.5 && npm install -g bun@1.4.4 && \
    ln -s /usr/local/lib/node_modules/opencode-linux-$arch/bin/opencode /usr/local/bin/opencode
RUN git clone --depth 1 --branch v1.19.5 https://github.com/anomalyco/opencode /opt/opencode/source && \
    cd /opt/opencode/source && bun install --frozen-lockfile --ignore-scripts && \
    git config --global user.email phoenix@localhost && git config --global user.name phoenix && \
    curl -fsSL https://models.dev/api.json -o /opt/opencode/models.json
