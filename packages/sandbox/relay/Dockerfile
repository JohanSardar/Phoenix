FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*
COPY relay.mjs /relay.mjs
ENTRYPOINT ["node", "/relay.mjs"]
