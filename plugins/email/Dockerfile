# The box the email working copy runs in during a replay: Node for the copy, libfaketime for the
# moment's clock, and the real himalaya command, which the copy points at its own IMAP and SMTP.
FROM node:24-bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    case "$TARGETARCH" in \
      arm64) asset=himalaya.aarch64-linux.tgz; sum=643020b220991fac67726f3be11310fcf806e757feadbbab3efbddd713597872 ;; \
      amd64) asset=himalaya.x86_64-linux.tgz; sum=e04e6382e3e664ef34b01afa1a2216113194a2975d2859727647b22d9b36d4e4 ;; \
      *) echo "no himalaya build for $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/himalaya.tgz "https://github.com/pimalaya/himalaya/releases/download/v1.2.0/$asset" && \
    echo "$sum  /tmp/himalaya.tgz" | sha256sum -c - && \
    mkdir /tmp/himalaya && tar -xzf /tmp/himalaya.tgz -C /tmp/himalaya && \
    install -m 0755 "$(find /tmp/himalaya -type f -name himalaya | head -1)" /usr/local/bin/himalaya && \
    rm -rf /tmp/himalaya /tmp/himalaya.tgz && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
