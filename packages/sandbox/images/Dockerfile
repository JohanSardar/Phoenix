FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime && \
    mkdir -p /usr/local/lib/faketime && \
    cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/faketime/ && \
    rm -rf /var/lib/apt/lists/*
