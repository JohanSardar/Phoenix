ARG SANDBOX_IMAGE=phoenix-sandbox:proof
FROM ${SANDBOX_IMAGE}
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      arm64) asset=aarch64; checksum=ca9441b104357e2105039dbfd4c2eaf0d6ee65a84085f23f51e880c95cbf46af ;; \
      amd64) asset=x86_64; checksum=f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599 ;; \
      *) exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/vercel-labs/fx/releases/download/v0.0.16/fx-linux-${asset}.tar.gz" -o /tmp/fx.tar.gz && \
    echo "$checksum  /tmp/fx.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/fx.tar.gz -C /usr/local/bin fx && rm /tmp/fx.tar.gz && fx --version
