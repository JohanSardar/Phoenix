FROM node:24-bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      arm64) asset=aarch64; checksum=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;; \
      amd64) asset=x86_64; checksum=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;; \
      *) exit 1 ;; \
    esac && \
    curl -fsSL "https://ziglang.org/download/0.17.0/zig-${asset}-linux-0.17.0.tar.xz" -o /tmp/zig.tar.xz && \
    echo "$checksum  /tmp/zig.tar.xz" | sha256sum -c - && \
    mkdir -p /opt/zig && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 && rm /tmp/zig.tar.xz && \
    ln -s /opt/zig/zig /usr/local/bin/zig
RUN git init -q /opt/fx-src && cd /opt/fx-src && \
    git fetch -q --depth 1 https://github.com/vercel-labs/fx 481104fdbc247aab4e987e875402dc735e82642e && \
    git -c advice.detachedHead=false checkout -q FETCH_HEAD
COPY stand-in.patch /opt/fx-stand-in.patch
RUN cd /opt/fx-src && git apply /opt/fx-stand-in.patch && \
    zig build -Doptimize=ReleaseSafe && install zig-out/bin/fx /usr/local/bin/fx && fx --version
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
